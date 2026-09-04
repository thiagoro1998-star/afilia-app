import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import pino from 'pino';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ROOT = process.env.SESSION_ROOT || './sessions';
const PORT = Number(process.env.PORT || 8080);
if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const sessions = new Map();
const localReady = new Set();
const reconnectAt = new Map();
const pairResumeMode = new Map();
let sessionKey = null;
let stopping = false;

const wait = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const isGroup = jid => typeof jid === 'string' && jid.endsWith('@g.us');
const codeOf = err => Number(err?.output?.statusCode || err?.statusCode || err?.data?.statusCode || 0);
await fs.mkdir(ROOT, { recursive: true });

async function assertPrivileged() {
  const { error } = await db.from('whatsapp_connections').select('id').limit(1);
  if (!error) return;
  if (String(error.message || '').includes('permission denied')) throw new Error('Railway is using anon/publishable Supabase key; use sb_secret_... or legacy service_role');
  throw error;
}
async function secret(name) {
  const { data, error } = await db.rpc('service_get_platform_secret', { p_name: name });
  if (error) throw error;
  if (!data) throw new Error(`missing secret ${name}`);
  return String(data);
}
async function encryptionKey() {
  if (!sessionKey) sessionKey = createHash('sha256').update(await secret('platform.whatsapp.session_key')).digest();
  return sessionKey;
}
async function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${Buffer.concat([body, cipher.getAuthTag()]).toString('base64')}`;
}
async function unseal(value) {
  const [iv64, payload64] = String(value || '').split('.');
  if (!iv64 || !payload64) throw new Error('invalid_session_blob');
  const payload = Buffer.from(payload64, 'base64');
  const body = payload.subarray(0, -16);
  const tag = payload.subarray(-16);
  const decipher = createDecipheriv('aes-256-gcm', await encryptionKey(), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
async function readFiles(root, dir = root, out = {}) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await readFiles(root, full, out);
    else out[path.relative(root, full)] = (await fs.readFile(full)).toString('base64');
  }
  return out;
}
async function restore(connectionId, dir) {
  const { data, error } = await db.rpc('service_get_whatsapp_session_blob', { p_connection_id: connectionId });
  if (error) throw error;
  if (!data) return false;
  const files = JSON.parse(await unseal(String(data)));
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const [name, b64] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.from(String(b64), 'base64'));
  }
  localReady.add(connectionId);
  return true;
}
async function persist(connectionId, userId, dir) {
  const encrypted = await seal(JSON.stringify(await readFiles(dir)));
  const { error } = await db.rpc('service_upsert_whatsapp_session_blob', {
    p_connection_id: connectionId,
    p_user_id: userId,
    p_encrypted_payload: encrypted
  });
  if (error) throw error;
}
async function setConnection(id, patch) {
  const { error } = await db.from('whatsapp_connections').update({ ...patch, updated_at: now() }).eq('id', id);
  if (error) throw error;
}
async function setPair(id, patch) {
  if (!id) return;
  const { error } = await db.from('whatsapp_pairing_requests').update({ ...patch, updated_at: now() }).eq('id', id);
  if (error) throw error;
}
async function pairAudit(userId, connectionId, requestId, kind, extra = {}) {
  try {
    await db.from('audit_events').insert({
      user_id: userId,
      event_type: 'whatsapp.pair_event',
      entity_type: 'whatsapp_connection',
      entity_id: connectionId,
      redacted_metadata: { request_id: requestId, kind, ...extra, at: now() }
    });
  } catch {}
}
async function upsertGroup(connectionId, userId, jid, name = '') {
  if (!isGroup(jid)) return;
  const { data: old, error } = await db.from('whatsapp_group_refs')
    .select('id,display_name')
    .eq('connection_id', connectionId)
    .eq('external_group_ref', jid)
    .maybeSingle();
  if (error) throw error;
  const display = name || old?.display_name || 'Grupo WhatsApp';
  if (old) {
    const { error: e } = await db.from('whatsapp_group_refs').update({ display_name: display, updated_at: now() }).eq('id', old.id);
    if (e) throw e;
  } else {
    const { error: e } = await db.from('whatsapp_group_refs').insert({
      user_id: userId,
      connection_id: connectionId,
      external_group_ref: jid,
      display_name: display,
      role: 'destination',
      is_enabled: false
    });
    if (e) throw e;
    log.info({ connectionId, jid, display }, 'group discovered');
  }
}
function wireDiscovery(connectionId, userId, sock) {
  const accept = (jid, name = '', source = '') => {
    if (!isGroup(jid)) return;
    upsertGroup(connectionId, userId, jid, name).catch(err => log.warn({ connectionId, jid, source, err: String(err) }, 'group upsert failed'));
  };
  sock.ev.on('messaging-history.set', event => {
    const chats = event?.chats || [];
    const messages = event?.messages || [];
    log.info({ connectionId, chats: chats.length, messages: messages.length, progress: event?.progress }, 'history received');
    for (const chat of chats) accept(chat?.id, chat?.name || chat?.displayName || '', 'history_chat');
    for (const msg of messages) {
      accept(msg?.key?.remoteJid, '', 'history_message');
      accept(msg?.key?.remoteJidAlt, '', 'history_message_alt');
    }
    db.from('audit_events').insert({
      user_id: userId,
      event_type: 'whatsapp.history_event',
      entity_type: 'whatsapp_connection',
      entity_id: connectionId,
      redacted_metadata: { chats: chats.length, messages: messages.length, progress: event?.progress ?? null, at: now() }
    }).catch(() => {});
  });
  sock.ev.on('chats.upsert', chats => { for (const chat of chats || []) accept(chat?.id, chat?.name || chat?.displayName || '', 'chat_upsert'); });
  sock.ev.on('chats.update', chats => { for (const chat of chats || []) accept(chat?.id, chat?.name || chat?.displayName || '', 'chat_update'); });
  sock.ev.on('messages.upsert', event => {
    for (const msg of event?.messages || []) {
      accept(msg?.key?.remoteJid, '', 'message');
      accept(msg?.key?.remoteJidAlt, '', 'message_alt');
    }
  });
  sock.ev.on('groups.upsert', groups => { for (const g of groups || []) accept(g?.id, g?.subject || '', 'groups_upsert'); });
  sock.ev.on('groups.update', groups => { for (const g of groups || []) accept(g?.id, g?.subject || '', 'groups_update'); });
  sock.ev.on('group-participants.update', event => accept(event?.id, '', 'participants'));
}

async function buildSocket(connectionId, userId, { requestId = null, fresh = false } = {}) {
  const old = sessions.get(connectionId);
  if (old) {
    try { old.sock.end(undefined); } catch {}
    sessions.delete(connectionId);
  }
  const dir = path.join(ROOT, connectionId);
  if (fresh) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    localReady.add(connectionId);
  } else if (!localReady.has(connectionId)) {
    const ok = await restore(connectionId, dir);
    if (!ok) {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      localReady.add(connectionId);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestWaWebVersion();
  const sock = makeWASocket({
    auth: state,
    version,
    logger: log.child({ connectionId }),
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: true,
    fireInitQueries: true,
    shouldSyncHistoryMessage: () => true,
    keepAliveIntervalMs: 20_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  });

  const session = {
    sock, userId, dir, requestId,
    mode: requestId ? 'pair' : 'connected',
    open: false,
    registered: Boolean(state.creds?.registered),
    lastQrAt: 0,
    lastActivityAt: Date.now(),
    qrCount: 0
  };
  sessions.set(connectionId, session);
  wireDiscovery(connectionId, userId, sock);

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      session.registered = Boolean(state.creds?.registered);
      session.lastActivityAt = Date.now();
      if (session.registered) {
        await persist(connectionId, userId, dir);
        if (requestId) await pairAudit(userId, connectionId, requestId, 'creds_registered');
      }
    } catch (err) { log.error({ connectionId, err: String(err) }, 'creds update failed'); }
  });

  sock.ev.on('connection.update', async update => {
    try {
      session.lastActivityAt = Date.now();
      if (update.qr && requestId) {
        session.lastQrAt = Date.now();
        session.qrCount += 1;
        await setPair(requestId, { status: 'qr_ready', qr_payload: update.qr, error_message: null });
        await pairAudit(userId, connectionId, requestId, 'qr', { seq: session.qrCount });
      }
      if (update.connection === 'open') {
        session.open = true;
        session.mode = 'connected';
        session.registered = true;
        await persist(connectionId, userId, dir);
        const rawId = String(sock.user?.id || '');
        const digits = rawId.split(':')[0].replace(/\D/g, '');
        await setConnection(connectionId, {
          status: 'connected', pairing_method: 'qr', phone_masked: digits ? `***${digits.slice(-4)}` : null,
          session_secret_configured: true, last_connected_at: now(), last_heartbeat_at: now()
        });
        if (requestId) {
          await setPair(requestId, { status: 'connected', qr_payload: null, error_message: null });
          await pairAudit(userId, connectionId, requestId, 'open');
        }
        reconnectAt.delete(connectionId);
        pairResumeMode.delete(requestId);
        log.info({ connectionId, requestId, version }, 'WhatsApp connection open');
      }
      if (update.connection === 'close') {
        session.open = false;
        if (sessions.get(connectionId)?.sock === sock) sessions.delete(connectionId);
        const code = codeOf(update.lastDisconnect?.error);
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        if (requestId) await pairAudit(userId, connectionId, requestId, 'close', { code, registered: session.registered });
        if (loggedOut) {
          localReady.delete(connectionId);
          await setConnection(connectionId, { status: 'disconnected', last_heartbeat_at: now() });
          if (requestId) await setPair(requestId, { status: 'failed', qr_payload: null, error_message: 'WhatsApp recusou/desconectou o vínculo.' });
          return;
        }
        if (requestId) {
          const resume = session.registered || code === DisconnectReason.restartRequired || code === 515;
          pairResumeMode.set(requestId, resume ? 'resume' : 'fresh');
          await setPair(requestId, { status: 'waiting_gateway', qr_payload: null, error_message: null });
          reconnectAt.set(connectionId, Date.now() + (resume ? 700 : 1200));
        } else {
          await setConnection(connectionId, { status: 'degraded', last_heartbeat_at: now() });
          reconnectAt.set(connectionId, Date.now() + ([408,428,503,515].includes(code) ? 1200 : 3000));
        }
        log.warn({ connectionId, requestId, code, registered: session.registered }, 'WhatsApp connection closed');
      }
    } catch (err) { log.error({ connectionId, requestId, err: String(err) }, 'connection handler failed'); }
  });
  return session;
}

async function recoverPairRequests() {
  const { data: reqs = [], error } = await db.from('whatsapp_pairing_requests')
    .select('id,user_id,connection_id,expires_at,status,updated_at')
    .in('status', ['waiting_gateway','qr_ready'])
    .order('created_at').limit(10);
  if (error) throw error;
  for (const req of reqs) {
    if (new Date(req.expires_at) <= new Date()) {
      await setPair(req.id, { status: 'expired', qr_payload: null, error_message: 'QR expirado. Gere uma nova conexão.' });
      const s = sessions.get(req.connection_id);
      if (s?.requestId === req.id) { try { s.sock.end(undefined); } catch {} sessions.delete(req.connection_id); }
      continue;
    }
    const current = sessions.get(req.connection_id);
    if (current?.requestId === req.id) continue;
    const notBefore = reconnectAt.get(req.connection_id) || 0;
    if (Date.now() < notBefore) continue;
    await setConnection(req.connection_id, { status: 'pairing', pairing_method: 'qr' });
    const mode = pairResumeMode.get(req.id);
    const fresh = mode ? mode === 'fresh' : req.status !== 'qr_ready';
    await setPair(req.id, { status: 'waiting_gateway', qr_payload: null, error_message: null });
    await pairAudit(req.user_id, req.connection_id, req.id, 'socket_start', { fresh });
    buildSocket(req.connection_id, req.user_id, { requestId: req.id, fresh }).catch(async err => {
      log.error({ requestId: req.id, err: String(err) }, 'pair socket start failed');
      await setPair(req.id, { status: 'failed', qr_payload: null, error_message: String(err?.message || err).slice(0,180) });
    });
  }
}

async function pairWatchdog() {
  for (const [connectionId, s] of sessions) {
    if (s.mode !== 'pair' || s.open || !s.requestId) continue;
    const ageQr = s.lastQrAt ? Date.now() - s.lastQrAt : 0;
    const idle = Date.now() - s.lastActivityAt;
    if (!s.registered && s.lastQrAt && ageQr > 35_000) {
      await pairAudit(s.userId, connectionId, s.requestId, 'qr_watchdog_restart', { age_ms: ageQr, qr_seq: s.qrCount });
      try { s.sock.end(undefined); } catch {}
      sessions.delete(connectionId);
      pairResumeMode.set(s.requestId, 'fresh');
      reconnectAt.set(connectionId, Date.now() + 500);
      await setPair(s.requestId, { status: 'waiting_gateway', qr_payload: null, error_message: null });
    } else if (s.registered && idle > 20_000) {
      await pairAudit(s.userId, connectionId, s.requestId, 'registered_watchdog_restart', { idle_ms: idle });
      try { s.sock.end(undefined); } catch {}
      sessions.delete(connectionId);
      pairResumeMode.set(s.requestId, 'resume');
      reconnectAt.set(connectionId, Date.now() + 500);
      await setPair(s.requestId, { status: 'waiting_gateway', qr_payload: null, error_message: null });
    }
  }
}

async function restoreConnections() {
  const { data: rows = [], error } = await db.from('whatsapp_connections')
    .select('id,user_id,status,session_secret_configured').in('status', ['connected','degraded']);
  if (error) throw error;
  for (const row of rows) {
    if (!row.session_secret_configured || sessions.has(row.id)) continue;
    const notBefore = reconnectAt.get(row.id) || 0;
    if (Date.now() < notBefore) continue;
    buildSocket(row.id, row.user_id, { fresh: false }).catch(err => {
      log.error({ connectionId: row.id, err: String(err) }, 'restore failed');
      reconnectAt.set(row.id, Date.now() + 5000);
    });
  }
}

async function downloadOfferImage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      'accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'referer': 'https://shopee.com.br/'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`image_http_${response.status}`);
  const contentType = String(response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!contentType.startsWith('image/')) throw new Error(`image_invalid_content_type_${contentType}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('image_empty');
  if (bytes.length > 12 * 1024 * 1024) throw new Error('image_too_large');
  return { bytes, contentType };
}

async function processJobs() {
  const { data: jobs = [], error } = await db.from('whatsapp_outbound_jobs')
    .select('id,user_id,connection_id,group_ref_id,offer_id,message_text,attempts,whatsapp_group_refs(external_group_ref,display_name)')
    .eq('status','queued').order('created_at').limit(20);
  if (error) throw error;
  for (const job of jobs) {
    const session = sessions.get(job.connection_id);
    if (!session?.open) continue;
    const jid = job.whatsapp_group_refs?.external_group_ref;
    if (!isGroup(jid)) continue;
    const attempts = Number(job.attempts || 0) + 1;
    const { data: lock } = await db.from('whatsapp_outbound_jobs')
      .update({ status:'processing', started_at:now(), attempts, updated_at:now(), last_error:null })
      .eq('id',job.id).eq('status','queued').select('id').maybeSingle();
    if (!lock) continue;
    try {
      let imageUrl = null;
      if (job.offer_id) {
        const { data: offer, error: offerError } = await db.from('offers')
          .select('image_url').eq('id', job.offer_id).eq('user_id', job.user_id).maybeSingle();
        if (offerError) throw offerError;
        imageUrl = offer?.image_url || null;
      }

      let sent;
      let mediaMode = 'text';
      if (imageUrl) {
        const image = await downloadOfferImage(imageUrl);
        sent = await session.sock.sendMessage(jid, {
          image: image.bytes,
          caption: job.message_text,
          mimetype: image.contentType
        });
        mediaMode = 'image';
      } else {
        sent = await session.sock.sendMessage(jid, { text: job.message_text });
      }

      await db.from('whatsapp_outbound_jobs').update({ status:'sent', sent_at:now(), external_message_id:sent?.key?.id||null, updated_at:now(), last_error:null }).eq('id',job.id);
      if (job.offer_id) await db.from('offers').update({ status:'published', published_at:now(), updated_at:now() }).eq('id',job.offer_id).eq('user_id',job.user_id);
      await db.from('audit_events').insert({ user_id:job.user_id, event_type:'offer.sent.whatsapp', entity_type:'offer', entity_id:job.offer_id, redacted_metadata:{group_ref_id:job.group_ref_id,message_id:sent?.key?.id||null,media_mode:mediaMode} });
    } catch (err) {
      const msg = String(err?.message || err).slice(0,500);
      await db.from('whatsapp_outbound_jobs').update({ status:attempts>=3?'failed':'queued', last_error:msg, updated_at:now() }).eq('id',job.id);
    }
  }
}
async function heartbeat() {
  for (const [id,s] of sessions) if (s.open) await setConnection(id,{last_heartbeat_at:now()});
}

createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/'||req.url==='/health'){
    const open=[...sessions.values()].filter(s=>s.open).length;
    const pairing=[...sessions.values()].filter(s=>s.mode==='pair'&&!s.open).length;
    res.writeHead(200);res.end(JSON.stringify({ok:true,service:'afilia-whatsapp-worker-v4.2-image',open,pairing,sessions:sessions.size,at:now()}));return;
  }
  res.writeHead(404);res.end('{}');
}).listen(PORT,'0.0.0.0',()=>log.info({port:PORT},'health server listening'));
process.on('SIGTERM',()=>{stopping=true;process.exit(0)});
process.on('SIGINT',()=>{stopping=true;process.exit(0)});

await assertPrivileged();
log.info('Afilia persistent WhatsApp gateway v4.2 image started');
for(;;){
  try{await recoverPairRequests();await pairWatchdog();await restoreConnections();await processJobs();await heartbeat()}catch(err){log.error({err:String(err)},'worker loop failed')}
  if(stopping)break;
  await wait(2500);
}