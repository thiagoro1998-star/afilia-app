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
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const log = pino({ level: LOG_LEVEL });
const sessions = new Map();
const reconnectTimers = new Map();
const persistTimers = new Map();
const probeTimers = new Map();
let platformSessionKey;
let stopping = false;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const isGroupJid = value => typeof value === 'string' && value.endsWith('@g.us');
const disconnectCode = err => Number(err?.output?.statusCode || err?.statusCode || err?.data?.statusCode || 0);

await fs.mkdir(ROOT, { recursive: true });

async function assertPrivilegedAccess() {
  const { error } = await db.from('whatsapp_connections').select('id').limit(1);
  if (!error) return;
  if (String(error.message || '').includes('permission denied')) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not privileged; use sb_secret_... or legacy service_role, never anon/publishable');
  }
  throw error;
}

async function platformSecret(name) {
  const { data, error } = await db.rpc('service_get_platform_secret', { p_name: name });
  if (error) throw error;
  if (!data) throw new Error(`missing platform secret: ${name}`);
  return String(data);
}

async function encryptionKey() {
  if (!platformSessionKey) {
    platformSessionKey = createHash('sha256')
      .update(await platformSecret('platform.whatsapp.session_key'))
      .digest();
  }
  return platformSessionKey;
}

async function decryptBlob(value) {
  const [iv64, payload64] = String(value || '').split('.');
  if (!iv64 || !payload64) throw new Error('invalid_session_blob');
  const payload = Buffer.from(payload64, 'base64');
  if (payload.length < 17) throw new Error('invalid_session_blob');
  const body = payload.subarray(0, -16);
  const tag = payload.subarray(-16);
  const decipher = createDecipheriv('aes-256-gcm', await encryptionKey(), Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

async function encryptBlob(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([body, cipher.getAuthTag()]);
  return `${iv.toString('base64')}.${payload.toString('base64')}`;
}

async function readSessionFiles(root, dir = root, out = {}) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await readSessionFiles(root, full, out);
    else out[path.relative(root, full)] = (await fs.readFile(full)).toString('base64');
  }
  return out;
}

async function restoreSession(connectionId, dir) {
  const { data, error } = await db.rpc('service_get_whatsapp_session_blob', { p_connection_id: connectionId });
  if (error) throw error;
  if (!data) return false;
  const files = JSON.parse(await decryptBlob(data));
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const [name, base64] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.from(String(base64), 'base64'));
  }
  return true;
}

async function persistSession(connectionId, userId, dir) {
  const encrypted = await encryptBlob(JSON.stringify(await readSessionFiles(dir)));
  const { error } = await db.rpc('service_upsert_whatsapp_session_blob', {
    p_connection_id: connectionId,
    p_user_id: userId,
    p_encrypted_payload: encrypted
  });
  if (error) throw error;
}

function schedulePersist(connectionId, userId, dir, delay = 800) {
  clearTimeout(persistTimers.get(connectionId));
  const timer = setTimeout(() => {
    persistTimers.delete(connectionId);
    persistSession(connectionId, userId, dir)
      .catch(err => log.error({ connectionId, err: String(err) }, 'session persist failed'));
  }, delay);
  persistTimers.set(connectionId, timer);
}

async function setConnection(id, patch) {
  const { error } = await db.from('whatsapp_connections')
    .update({ ...patch, updated_at: now() })
    .eq('id', id);
  if (error) throw error;
}

async function upsertGroup(connectionId, userId, jid, displayName = '') {
  if (!isGroupJid(jid)) return false;
  const { data: existing, error: lookupError } = await db.from('whatsapp_group_refs')
    .select('id,is_enabled,display_name')
    .eq('connection_id', connectionId)
    .eq('external_group_ref', jid)
    .maybeSingle();
  if (lookupError) throw lookupError;

  const name = displayName || existing?.display_name || 'Grupo WhatsApp';
  if (existing) {
    const { error } = await db.from('whatsapp_group_refs')
      .update({ display_name: name, updated_at: now() })
      .eq('id', existing.id);
    if (error) throw error;
  } else {
    const { error } = await db.from('whatsapp_group_refs').insert({
      user_id: userId,
      connection_id: connectionId,
      external_group_ref: jid,
      display_name: name,
      role: 'destination',
      is_enabled: false
    });
    if (error) throw error;
    log.info({ connectionId, jid, name }, 'new WhatsApp group discovered');
  }
  return true;
}

async function saveCandidate(connectionId, userId, sock, jid, hint = '', source = 'unknown') {
  if (!isGroupJid(jid)) return false;
  let name = hint;
  if (!name) {
    try {
      const meta = await sock.groupMetadata(jid);
      name = meta?.subject || '';
    } catch (err) {
      log.debug({ connectionId, jid, source, err: String(err) }, 'metadata unavailable');
    }
  }
  return upsertGroup(connectionId, userId, jid, name || 'Grupo WhatsApp');
}

function groupJidFromNode(node) {
  if (!node || typeof node !== 'object') return null;
  const attrs = node.attrs || {};
  for (const key of ['jid', 'id', 'group', 'to', 'from']) {
    const value = attrs[key];
    if (isGroupJid(value)) return value;
  }
  if (node.tag === 'group') {
    const id = String(attrs.id || attrs.jid || '');
    if (/^\d+-\d+$/.test(id)) return `${id}@g.us`;
  }
  return null;
}

function extractRawGroups(node, result = new Map(), tags = {}) {
  if (!node || typeof node !== 'object') return { result, tags };
  if (node.tag) tags[node.tag] = (tags[node.tag] || 0) + 1;
  const jid = groupJidFromNode(node);
  if (jid) {
    const attrs = node.attrs || {};
    const hint = String(attrs.subject || attrs.name || attrs.display_name || '');
    if (!result.has(jid) || hint) result.set(jid, hint);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) extractRawGroups(child, result, tags);
  }
  return { result, tags };
}

async function rawParticipatingQuery(sock) {
  const response = await sock.query({
    tag: 'iq',
    attrs: { to: '@g.us', xmlns: 'w:g2', type: 'get' },
    content: [{
      tag: 'participating',
      attrs: {},
      content: [
        { tag: 'participants', attrs: {} },
        { tag: 'description', attrs: {} }
      ]
    }]
  });
  return extractRawGroups(response);
}

async function recordProbe(connectionId, userId, metadata) {
  try {
    await db.from('audit_events').insert({
      user_id: userId,
      event_type: 'whatsapp.group_probe',
      entity_type: 'whatsapp_connection',
      entity_id: connectionId,
      redacted_metadata: metadata
    });
  } catch (err) {
    log.debug({ connectionId, err: String(err) }, 'probe audit skipped');
  }
}

async function probeGroups(connectionId, userId, sock, source = 'scheduled') {
  let officialCount = 0;
  let rawCount = 0;
  let officialError = null;
  let rawError = null;
  let tags = {};

  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups || {});
    officialCount = list.length;
    for (const group of list) {
      await saveCandidate(connectionId, userId, sock, group?.id, group?.subject || '', `${source}:official`);
    }
  } catch (err) {
    officialError = `${disconnectCode(err) || ''}:${String(err?.message || err).slice(0, 180)}`;
    log.warn({ connectionId, source, err: officialError }, 'official group query failed');
  }

  try {
    const raw = await rawParticipatingQuery(sock);
    rawCount = raw.result.size;
    tags = raw.tags;
    for (const [jid, hint] of raw.result.entries()) {
      await saveCandidate(connectionId, userId, sock, jid, hint, `${source}:raw`);
    }
  } catch (err) {
    rawError = `${disconnectCode(err) || ''}:${String(err?.message || err).slice(0, 180)}`;
    log.warn({ connectionId, source, err: rawError }, 'raw group query failed');
  }

  const { count: dbCount } = await db.from('whatsapp_group_refs')
    .select('*', { count: 'exact', head: true })
    .eq('connection_id', connectionId);

  const probe = {
    source,
    official_count: officialCount,
    raw_count: rawCount,
    db_count: dbCount || 0,
    official_error: officialError,
    raw_error: rawError,
    raw_tags: tags,
    at: now()
  };
  await recordProbe(connectionId, userId, probe);
  log.info({ connectionId, ...probe }, 'group probe complete');
  return probe;
}

function wireLiveDiscovery(connectionId, userId, sock) {
  const discover = (jid, hint, source) => {
    saveCandidate(connectionId, userId, sock, jid, hint, source)
      .catch(err => log.warn({ connectionId, jid, source, err: String(err) }, 'live group discovery failed'));
  };

  sock.ev.on('messaging-history.set', event => {
    log.info({
      connectionId,
      chats: event?.chats?.length || 0,
      messages: event?.messages?.length || 0,
      progress: event?.progress
    }, 'history chunk received');
    for (const chat of event?.chats || []) discover(chat?.id, chat?.name || chat?.displayName || '', 'history_chat');
    for (const msg of event?.messages || []) {
      discover(msg?.key?.remoteJid, '', 'history_message');
      discover(msg?.key?.remoteJidAlt, '', 'history_message_alt');
    }
  });

  sock.ev.on('chats.upsert', chats => {
    for (const chat of chats || []) discover(chat?.id, chat?.name || chat?.displayName || '', 'chat_upsert');
  });
  sock.ev.on('chats.update', chats => {
    for (const chat of chats || []) discover(chat?.id, chat?.name || chat?.displayName || '', 'chat_update');
  });
  sock.ev.on('messages.upsert', event => {
    for (const msg of event?.messages || []) {
      discover(msg?.key?.remoteJid, '', 'message');
      discover(msg?.key?.remoteJidAlt, '', 'message_alt');
    }
  });
  sock.ev.on('groups.upsert', groups => {
    for (const group of groups || []) discover(group?.id, group?.subject || '', 'groups_upsert');
  });
  sock.ev.on('groups.update', groups => {
    for (const group of groups || []) discover(group?.id, group?.subject || '', 'groups_update');
  });
  sock.ev.on('group-participants.update', event => discover(event?.id, '', 'participants_update'));
}

function scheduleReconnect(connectionId, userId, delay = 2500) {
  if (stopping || reconnectTimers.has(connectionId)) return;
  const timer = setTimeout(() => {
    reconnectTimers.delete(connectionId);
    startConnection(connectionId, userId).catch(err => {
      log.error({ connectionId, err: String(err) }, 'reconnect failed');
      scheduleReconnect(connectionId, userId, 5000);
    });
  }, delay);
  reconnectTimers.set(connectionId, timer);
}

function scheduleProbe(connectionId, userId, sock, delay, source) {
  const key = `${connectionId}:${source}`;
  clearTimeout(probeTimers.get(key));
  const timer = setTimeout(() => {
    probeTimers.delete(key);
    const current = sessions.get(connectionId);
    if (!current?.open || current.sock !== sock) return;
    probeGroups(connectionId, userId, sock, source).catch(err =>
      log.error({ connectionId, source, err: String(err) }, 'scheduled probe failed')
    );
  }, delay);
  probeTimers.set(key, timer);
}

async function startConnection(connectionId, userId) {
  const active = sessions.get(connectionId);
  if (active) return active.sock;

  const dir = path.join(ROOT, connectionId);
  await fs.mkdir(dir, { recursive: true });
  const restored = await restoreSession(connectionId, dir);
  if (!restored) throw new Error('session_not_found');

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

  const session = { sock, userId, dir, open: false, openedAt: null };
  sessions.set(connectionId, session);

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      schedulePersist(connectionId, userId, dir);
    } catch (err) {
      log.error({ connectionId, err: String(err) }, 'creds update failed');
    }
  });

  wireLiveDiscovery(connectionId, userId, sock);

  sock.ev.on('connection.update', async update => {
    try {
      if (update.connection === 'open') {
        session.open = true;
        session.openedAt = Date.now();
        const rawId = String(sock.user?.id || '');
        const digits = rawId.split(':')[0].replace(/\D/g, '');
        await setConnection(connectionId, {
          status: 'connected',
          phone_masked: digits ? `***${digits.slice(-4)}` : null,
          session_secret_configured: true,
          last_connected_at: now(),
          last_heartbeat_at: now()
        });
        await persistSession(connectionId, userId, dir);
        log.info({ connectionId, version, userId: rawId }, 'persistent WhatsApp connection opened');

        scheduleProbe(connectionId, userId, sock, 2000, 'open_2s');
        scheduleProbe(connectionId, userId, sock, 12000, 'open_12s');
        scheduleProbe(connectionId, userId, sock, 45000, 'open_45s');
        scheduleProbe(connectionId, userId, sock, 120000, 'open_120s');
      }

      if (update.connection === 'close') {
        session.open = false;
        sessions.delete(connectionId);
        const code = disconnectCode(update.lastDisconnect?.error);
        const loggedOut = code === DisconnectReason.loggedOut;
        await setConnection(connectionId, {
          status: loggedOut ? 'disconnected' : 'reconnecting',
          last_heartbeat_at: now()
        });
        log.warn({ connectionId, code, loggedOut }, 'persistent WhatsApp connection closed');
        if (!loggedOut) {
          scheduleReconnect(connectionId, userId, [408, 428, 503, 515].includes(code) ? 1200 : 3500);
        }
      }
    } catch (err) {
      log.error({ connectionId, err: String(err) }, 'connection update handler failed');
    }
  });

  return sock;
}

async function ensureConnections() {
  const { data: rows = [], error } = await db.from('whatsapp_connections')
    .select('id,user_id,status,session_secret_configured')
    .in('status', ['connected', 'reconnecting']);
  if (error) throw error;
  for (const row of rows) {
    if (!row.session_secret_configured || sessions.has(row.id)) continue;
    startConnection(row.id, row.user_id).catch(err => {
      log.error({ connectionId: row.id, err: String(err) }, 'connection restore failed');
      scheduleReconnect(row.id, row.user_id, 5000);
    });
  }
}

async function processJobs() {
  const { data: jobs = [], error } = await db.from('whatsapp_outbound_jobs')
    .select('id,user_id,connection_id,group_ref_id,offer_id,message_text,attempts,whatsapp_group_refs(external_group_ref,display_name)')
    .eq('status', 'queued')
    .order('created_at')
    .limit(20);
  if (error) throw error;

  for (const job of jobs) {
    const session = sessions.get(job.connection_id);
    if (!session?.open) continue;
    const jid = job.whatsapp_group_refs?.external_group_ref;
    if (!isGroupJid(jid)) continue;

    const attempts = Number(job.attempts || 0) + 1;
    const { data: locked, error: lockError } = await db.from('whatsapp_outbound_jobs')
      .update({
        status: 'processing',
        started_at: now(),
        attempts,
        last_error: null,
        updated_at: now()
      })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle();
    if (lockError || !locked) continue;

    try {
      const sent = await session.sock.sendMessage(jid, { text: job.message_text });
      await db.from('whatsapp_outbound_jobs').update({
        status: 'sent',
        sent_at: now(),
        external_message_id: sent?.key?.id || null,
        last_error: null,
        updated_at: now()
      }).eq('id', job.id);
      if (job.offer_id) {
        await db.from('offers').update({
          status: 'published',
          published_at: now(),
          updated_at: now()
        }).eq('id', job.offer_id).eq('user_id', job.user_id);
      }
      await db.from('audit_events').insert({
        user_id: job.user_id,
        event_type: 'offer.sent.whatsapp',
        entity_type: 'offer',
        entity_id: job.offer_id,
        redacted_metadata: { group_ref_id: job.group_ref_id, message_id: sent?.key?.id || null }
      });
      log.info({ jobId: job.id, jid }, 'WhatsApp job sent');
    } catch (err) {
      const message = String(err?.message || err).slice(0, 500);
      const next = attempts >= 3 ? 'failed' : 'queued';
      await db.from('whatsapp_outbound_jobs').update({
        status: next,
        last_error: message,
        updated_at: now()
      }).eq('id', job.id);
      log.error({ jobId: job.id, jid, err: message }, 'WhatsApp job failed');
    }
  }
}

async function heartbeatAndPeriodicProbe() {
  for (const [connectionId, session] of sessions.entries()) {
    if (!session.open) continue;
    await setConnection(connectionId, { last_heartbeat_at: now() });
    const age = Date.now() - (session.openedAt || Date.now());
    if (age > 60_000 && age % 300_000 < 12_000) {
      probeGroups(connectionId, session.userId, session.sock, 'periodic_5m')
        .catch(err => log.warn({ connectionId, err: String(err) }, 'periodic probe failed'));
    }
  }
}

createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health' || req.url === '/') {
    const connected = [...sessions.values()].filter(s => s.open).length;
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'afilia-whatsapp-worker-v2', connected, sessions: sessions.size, at: now() }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false }));
}).listen(PORT, '0.0.0.0', () => log.info({ port: PORT }, 'health server listening'));

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  for (const [connectionId, session] of sessions.entries()) {
    try { await persistSession(connectionId, session.userId, session.dir); } catch {}
    try { session.sock.end(undefined); } catch {}
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await assertPrivilegedAccess();
await ensureConnections();
log.info('Afilia persistent WhatsApp gateway v2 started');

for (;;) {
  try {
    await ensureConnections();
    await processJobs();
    await heartbeatAndPeriodicProbe();
  } catch (err) {
    log.error({ err: String(err) }, 'worker loop failed');
  }
  await wait(10_000);
}
