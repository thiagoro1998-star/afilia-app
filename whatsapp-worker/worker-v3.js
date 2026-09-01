import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeInMemoryStore,
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
const reconnectTimers = new Map();
const persistTimers = new Map();
const localReady = new Set();
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
  const files = JSON.parse(await unseal(data));
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
function schedulePersist(connectionId, userId, dir) {
  clearTimeout(persistTimers.get(connectionId));
  persistTimers.set(connectionId, setTimeout(() => {
    persistTimers.delete(connectionId);
    persist(connectionId, userId, dir).catch(err => log.error({ connectionId, err: String(err) }, 'persist failed'));
  }, 500));
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
    await db.from('whatsapp_group_refs').update({ display_name: display, updated_at: now() }).eq('id', old.id);
  } else {
    const { error: insertError } = await db.from('whatsapp_group_refs').insert({
      user_id: userId,
      connection_id: connectionId,
      external_group_ref: jid,
      display_name: display,
      role: 'destination',
      is_enabled: false
    });
    if (insertError) throw insertError;
    log.info({ connectionId, jid, display }, 'group discovered');
  }
}
async function discover(connectionId, userId, sock, jid, hint = '', source = 'event') {
  if (!isGroup(jid)) return;
  let name = hint;
  if (!name) {
    try { name = (await sock.groupMetadata(jid))?.subject || ''; } catch {}
  }
  await upsertGroup(connectionId, userId, jid, name || 'Grupo WhatsApp');
  log.debug({ connectionId, jid, source }, 'group candidate processed');
}
async function scanStore(connectionId, userId, sock, store, source) {
  const chats = store?.chats?.all?.() || [];
  let groups = 0;
  for (const chat of chats) {
    if (!isGroup(chat?.id)) continue;
    groups++;
    await discover(connectionId, userId, sock, chat.id, chat.name || chat.displayName || '', `${source}:store`);
  }
  const { count } = await db.from('whatsapp_group_refs').select('*', { head: true, count: 'exact' }).eq('connection_id', connectionId);
  try {
    await db.from('audit_events').insert({
      user_id: userId,
      event_type: 'whatsapp.history_probe',
      entity_type: 'whatsapp_connection',
      entity_id: connectionId,
      redacted_metadata: { source, chats: chats.length, store_groups: groups, db_groups: count || 0, at: now() }
    });
  } catch {}
  log.info({ connectionId, source, chats: chats.length, groups, dbGroups: count || 0 }, 'store scan');
}
function wireDiscovery(connectionId, userId, sock, store) {
  const laterScan = source => scanStore(connectionId, userId, sock, store, source).catch(err => log.warn({ connectionId, source, err: String(err) }, 'store scan failed'));
  sock.ev.on('messaging-history.set', event => {
    log.info({ connectionId, chats: event?.chats?.length || 0, messages: event?.messages?.length || 0, progress: event?.progress }, 'history received');
    for (const chat of event?.chats || []) discover(connectionId, userId, sock, chat?.id, chat?.name || chat?.displayName || '', 'history_chat').catch(() => {});
    for (const msg of event?.messages || []) {
      discover(connectionId, userId, sock, msg?.key?.remoteJid, '', 'history_message').catch(() => {});
      discover(connectionId, userId, sock, msg?.key?.remoteJidAlt, '', 'history_alt').catch(() => {});
    }
    setTimeout(() => laterScan('history_event'), 250);
  });
  sock.ev.on('chats.upsert', chats => {
    for (const chat of chats || []) discover(connectionId, userId, sock, chat?.id, chat?.name || chat?.displayName || '', 'chat_upsert').catch(() => {});
    setTimeout(() => laterScan('chats_upsert'), 250);
  });
  sock.ev.on('messages.upsert', event => {
    for (const msg of event?.messages || []) {
      discover(connectionId, userId, sock, msg?.key?.remoteJid, '', 'message').catch(() => {});
      discover(connectionId, userId, sock, msg?.key?.remoteJidAlt, '', 'message_alt').catch(() => {});
    }
  });
  sock.ev.on('groups.upsert', groups => {
    for (const group of groups || []) discover(connectionId, userId, sock, group?.id, group?.subject || '', 'groups_upsert').catch(() => {});
  });
  sock.ev.on('groups.update', groups => {
    for (const group of groups || []) discover(connectionId, userId, sock, group?.id, group?.subject || '', 'groups_update').catch(() => {});
  });
  sock.ev.on('group-participants.update', event => discover(connectionId, userId, sock, event?.id, '', 'participants').catch(() => {}));
  return laterScan;
}
function scheduleReconnect(connectionId, userId, pairRequestId = null, delay = 1800) {
  if (stopping || reconnectTimers.has(connectionId)) return;
  reconnectTimers.set(connectionId, setTimeout(() => {
    reconnectTimers.delete(connectionId);
    startConnection(connectionId, userId, { pairRequestId, fresh: false }).catch(err => {
      log.error({ connectionId, err: String(err) }, 'reconnect failed');
      scheduleReconnect(connectionId, userId, pairRequestId, 4000);
    });
  }, delay));
}
async function startConnection(connectionId, userId, { pairRequestId = null, fresh = false } = {}) {
  const previous = sessions.get(connectionId);
  if (previous) {
    try { previous.sock.end(undefined); } catch {}
    sessions.delete(connectionId);
  }
  const dir = path.join(ROOT, connectionId);
  if (fresh) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    localReady.add(connectionId);
  } else if (!localReady.has(connectionId)) {
    const ok = await restore(connectionId, dir);
    if (!ok) throw new Error('session_not_found');
  }

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestWaWebVersion();
  const store = makeInMemoryStore({ logger: log.child({ connectionId, part: 'store' }) });
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
  store.bind(sock.ev);
  const session = { sock, store, userId, dir, open: false, pairRequestId };
  sessions.set(connectionId, session);
  const laterScan = wireDiscovery(connectionId, userId, sock, store);

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      schedulePersist(connectionId, userId, dir);
    } catch (err) { log.error({ connectionId, err: String(err) }, 'creds update failed'); }
  });

  sock.ev.on('connection.update', async update => {
    try {
      if (update.qr && pairRequestId) {
        await setPair(pairRequestId, { status: 'qr_ready', qr_payload: update.qr, error_message: null });
      }
      if (update.connection === 'open') {
        session.open = true;
        await persist(connectionId, userId, dir);
        const rawId = String(sock.user?.id || '');
        const digits = rawId.split(':')[0].replace(/\D/g, '');
        await setConnection(connectionId, {
          status: 'connected', pairing_method: 'qr', phone_masked: digits ? `***${digits.slice(-4)}` : null,
          session_secret_configured: true, last_connected_at: now(), last_heartbeat_at: now()
        });
        if (pairRequestId) await setPair(pairRequestId, { status: 'connected', qr_payload: null, error_message: null });
        log.info({ connectionId, pairRequestId, version }, 'WhatsApp connection open');
        for (const [delay, label] of [[1000,'open_1s'],[5000,'open_5s'],[15000,'open_15s'],[30000,'open_30s'],[60000,'open_60s'],[120000,'open_120s']]) {
          setTimeout(() => { const current = sessions.get(connectionId); if (current?.sock === sock && current.open) laterScan(label); }, delay);
        }
      }
      if (update.connection === 'close') {
        session.open = false;
        if (sessions.get(connectionId)?.sock === sock) sessions.delete(connectionId);
        const code = codeOf(update.lastDisconnect?.error);
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        await setConnection(connectionId, { status: loggedOut ? 'disconnected' : 'reconnecting', last_heartbeat_at: now() });
        log.warn({ connectionId, code, loggedOut, pairRequestId }, 'WhatsApp connection closed');
        if (loggedOut) {
          if (pairRequestId) await setPair(pairRequestId, { status: 'failed', qr_payload: null, error_message: 'WhatsApp desconectado' });
          localReady.delete(connectionId);
        } else {
          scheduleReconnect(connectionId, userId, pairRequestId, [408,428,503,515].includes(code) ? 1000 : 2500);
        }
      }
    } catch (err) { log.error({ connectionId, err: String(err) }, 'connection handler failed'); }
  });
  return sock;
}
async function consumePairings() {
  const { data: reqs = [], error } = await db.from('whatsapp_pairing_requests')
    .select('id,user_id,connection_id,expires_at,status').eq('status','waiting_gateway').order('created_at').limit(5);
  if (error) throw error;
  for (const req of reqs) {
    if (new Date(req.expires_at) < new Date()) { await setPair(req.id, { status: 'expired' }); continue; }
    const current = sessions.get(req.connection_id);
    if (current?.pairRequestId === req.id) continue;
    await setConnection(req.connection_id, { status: 'pairing', pairing_method: 'qr' });
    startConnection(req.connection_id, req.user_id, { pairRequestId: req.id, fresh: true })
      .catch(async err => { log.error({ requestId:req.id, err:String(err) }, 'pair start failed'); await setPair(req.id,{status:'failed',error_message:String(err?.message||err).slice(0,180)}); });
  }
}
async function restoreConnections() {
  const { data: rows = [], error } = await db.from('whatsapp_connections')
    .select('id,user_id,status,session_secret_configured').in('status',['connected','reconnecting']);
  if (error) throw error;
  for (const row of rows) {
    if (!row.session_secret_configured || sessions.has(row.id)) continue;
    startConnection(row.id,row.user_id,{fresh:false}).catch(err => { log.error({connectionId:row.id,err:String(err)},'restore failed'); scheduleReconnect(row.id,row.user_id,null,4000); });
  }
}
async function processJobs() {
  const { data: jobs = [], error } = await db.from('whatsapp_outbound_jobs')
    .select('id,user_id,connection_id,group_ref_id,offer_id,message_text,attempts,whatsapp_group_refs(external_group_ref,display_name)')
    .eq('status','queued').order('created_at').limit(20);
  if (error) throw error;
  for (const job of jobs) {
    const session = sessions.get(job.connection_id); if (!session?.open) continue;
    const jid = job.whatsapp_group_refs?.external_group_ref; if (!isGroup(jid)) continue;
    const attempts = Number(job.attempts||0)+1;
    const { data: lock } = await db.from('whatsapp_outbound_jobs').update({status:'processing',started_at:now(),attempts,updated_at:now(),last_error:null}).eq('id',job.id).eq('status','queued').select('id').maybeSingle();
    if (!lock) continue;
    try {
      const sent = await session.sock.sendMessage(jid,{text:job.message_text});
      await db.from('whatsapp_outbound_jobs').update({status:'sent',sent_at:now(),external_message_id:sent?.key?.id||null,updated_at:now(),last_error:null}).eq('id',job.id);
      if (job.offer_id) await db.from('offers').update({status:'published',published_at:now(),updated_at:now()}).eq('id',job.offer_id).eq('user_id',job.user_id);
      await db.from('audit_events').insert({user_id:job.user_id,event_type:'offer.sent.whatsapp',entity_type:'offer',entity_id:job.offer_id,redacted_metadata:{group_ref_id:job.group_ref_id,message_id:sent?.key?.id||null}});
    } catch (err) {
      const msg=String(err?.message||err).slice(0,500); await db.from('whatsapp_outbound_jobs').update({status:attempts>=3?'failed':'queued',last_error:msg,updated_at:now()}).eq('id',job.id);
    }
  }
}
async function heartbeat() {
  for (const [id,s] of sessions) if (s.open) await setConnection(id,{last_heartbeat_at:now()});
}

createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/'||req.url==='/health'){const open=[...sessions.values()].filter(s=>s.open).length;res.writeHead(200);res.end(JSON.stringify({ok:true,service:'afilia-whatsapp-worker-v3',open,sessions:sessions.size,at:now()}));return}res.writeHead(404);res.end('{}')}).listen(PORT,'0.0.0.0',()=>log.info({port:PORT},'health server listening'));
process.on('SIGTERM',()=>{stopping=true;process.exit(0)});process.on('SIGINT',()=>{stopping=true;process.exit(0)});

await assertPrivileged();
await restoreConnections();
log.info('Afilia persistent WhatsApp gateway v3 started');
for(;;){try{await consumePairings();await restoreConnections();await processJobs();await heartbeat()}catch(err){log.error({err:String(err)},'worker loop failed')}await wait(3000)}
