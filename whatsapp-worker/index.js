import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
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

const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const sessions = new Map();
const restoredThisBoot = new Set();
const persistTimers = new Map();
const groupTasks = new Map();
const reconnectTimers = new Map();
let stopping = false;
let platformSessionKey = null;

await fs.mkdir(ROOT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const isGroup = jid => typeof jid === 'string' && jid.endsWith('@g.us');
const disconnectCode = err => Number(err?.output?.statusCode || err?.statusCode || err?.data?.statusCode || 0);

async function platformSecret(name) {
  const { data, error } = await db.rpc('service_get_platform_secret', { p_name: name });
  if (error) throw error;
  return String(data || '');
}
async function encryptionKey() {
  if (!platformSessionKey) platformSessionKey = createHash('sha256').update(await platformSecret('platform.whatsapp.session_key')).digest();
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
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await readSessionFiles(root, p, out);
    else out[path.relative(root, p)] = (await fs.readFile(p)).toString('base64');
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
    const p = path.join(dir, name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, Buffer.from(String(base64), 'base64'));
  }
  return true;
}
async function persistSession(connectionId, userId, dir) {
  const payload = await encryptBlob(JSON.stringify(await readSessionFiles(dir)));
  const { error } = await db.rpc('service_upsert_whatsapp_session_blob', {
    p_connection_id: connectionId,
    p_user_id: userId,
    p_encrypted_payload: payload
  });
  if (error) throw error;
}
function schedulePersist(connectionId, userId, dir, delay = 700) {
  clearTimeout(persistTimers.get(connectionId));
  const timer = setTimeout(() => {
    persistTimers.delete(connectionId);
    persistSession(connectionId, userId, dir).catch(err => log.error({ connectionId, err: String(err) }, 'session persist failed'));
  }, delay);
  persistTimers.set(connectionId, timer);
}
async function setConnection(id, patch) {
  const { error } = await db.from('whatsapp_connections').update({ ...patch, updated_at: now() }).eq('id', id);
  if (error) throw error;
}

async function upsertGroup(connectionId, userId, jid, displayName) {
  if (!isGroup(jid)) return false;
  const { data: old, error: lookupError } = await db.from('whatsapp_group_refs')
    .select('id,is_enabled,display_name')
    .eq('connection_id', connectionId)
    .eq('external_group_ref', jid)
    .maybeSingle();
  if (lookupError) throw lookupError;
  const name = displayName || old?.display_name || 'Grupo WhatsApp';
  if (old) {
    const { error } = await db.from('whatsapp_group_refs').update({ display_name: name, updated_at: now() }).eq('id', old.id);
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
function discoverGroup(connectionId, userId, sock, jid, hint = '', source = 'event') {
  if (!isGroup(jid)) return;
  const key = `${connectionId}:${jid}`;
  if (groupTasks.has(key)) return;
  const task = (async () => {
    let name = hint;
    if (!name) {
      try {
        const metadata = await sock.groupMetadata(jid);
        name = metadata?.subject || '';
      } catch (err) {
        log.debug({ connectionId, jid, source, err: String(err) }, 'group metadata unavailable');
      }
    }
    await upsertGroup(connectionId, userId, jid, name || 'Grupo WhatsApp');
  })().catch(err => log.error({ connectionId, jid, source, err: String(err) }, 'group discovery failed')).finally(() => groupTasks.delete(key));
  groupTasks.set(key, task);
}
async function fetchParticipatingGroups(connectionId, userId, sock, source = 'direct') {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups || {});
    for (const g of list) discoverGroup(connectionId, userId, sock, g?.id, g?.subject || '', source);
    log.info({ connectionId, count: list.length, source }, 'participating groups fetched');
    return list.length;
  } catch (err) {
    log.warn({ connectionId, source, err: String(err) }, 'participating group fetch failed');
    return 0;
  }
}
function wireGroupDiscovery(connectionId, userId, sock) {
  const ev = sock.ev;
  ev.on('messaging-history.set', event => {
    log.info({ connectionId, chats: event?.chats?.length || 0, messages: event?.messages?.length || 0, progress: event?.progress }, 'WhatsApp history chunk');
    for (const chat of event?.chats || []) discoverGroup(connectionId, userId, sock, chat?.id, chat?.name || chat?.displayName || '', 'history_chat');
    for (const msg of event?.messages || []) {
      discoverGroup(connectionId, userId, sock, msg?.key?.remoteJid, '', 'history_message');
      discoverGroup(connectionId, userId, sock, msg?.key?.remoteJidAlt, '', 'history_message_alt');
    }
  });
  ev.on('chats.upsert', chats => {
    for (const chat of chats || []) discoverGroup(connectionId, userId, sock, chat?.id, chat?.name || chat?.displayName || '', 'chat_upsert');
  });
  ev.on('chats.update', chats => {
    for (const chat of chats || []) discoverGroup(connectionId, userId, sock, chat?.id, chat?.name || chat?.displayName || '', 'chat_update');
  });
  ev.on('messages.upsert', event => {
    for (const msg of event?.messages || []) {
      discoverGroup(connectionId, userId, sock, msg?.key?.remoteJid, '', 'message');
      discoverGroup(connectionId, userId, sock, msg?.key?.remoteJidAlt, '', 'message_alt');
    }
  });
  ev.on('groups.upsert', groups => {
    for (const g of groups || []) discoverGroup(connectionId, userId, sock, g?.id, g?.subject || '', 'groups_upsert');
  });
  ev.on('groups.update', groups => {
    for (const g of groups || []) discoverGroup(connectionId, userId, sock, g?.id, g?.subject || '', 'groups_update');
  });
  ev.on('group-participants.update', event => discoverGroup(connectionId, userId, sock, event?.id, '', 'participants'));
}

function scheduleReconnect(connectionId, userId, delay = 3000) {
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
async function startConnection(connectionId, userId) {
  const existing = sessions.get(connectionId);
  if (existing) return existing.sock;
  const dir = path.join(ROOT, connectionId);
  await fs.mkdir(dir, { recursive: true });
  if (!restoredThisBoot.has(connectionId)) {
    const restored = await restoreSession(connectionId, dir);
    if (!restored) throw new Error('session_not_found');
    restoredThisBoot.add(connectionId);
  }
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    version,
    logger: log.child({ connectionId }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: true,
    fireInitQueries: true,
    shouldSyncHistoryMessage: () => true,
    browser: ['Ubuntu', 'Chrome', '1.0.0']
  });
  const stateObj = { sock, userId, dir, open: false, openedAt: null };
  sessions.set(connectionId, stateObj);
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      schedulePersist(connectionId, userId, dir);
    } catch (err) {
      log.error({ connectionId, err: String(err) }, 'creds update failed');
    }
  });
  wireGroupDiscovery(connectionId, userId, sock);
  sock.ev.on('connection.update', async update => {
    try {
      if (update.connection === 'open') {
        stateObj.open = true;
        stateObj.openedAt = Date.now();
        const digits = String(sock.user?.id || '').split(':')[0].replace(/\D/g, '');
        await setConnection(connectionId, {
          status: 'connected',
          phone_masked: digits ? `***${digits.slice(-4)}` : null,
          session_secret_configured: true,
          last_connected_at: now(),
          last_heartbeat_at: now()
        });
        await persistSession(connectionId, userId, dir);
        log.info({ connectionId, version }, 'persistent WhatsApp connection opened');
        setTimeout(() => fetchParticipatingGroups(connectionId, userId, sock, 'open_2s'), 2000);
        setTimeout(() => fetchParticipatingGroups(connectionId, userId, sock, 'open_15s'), 15000);
        setTimeout(() => fetchParticipatingGroups(connectionId, userId, sock, 'open_60s'), 60000);
      }
      if (update.connection === 'close') {
        stateObj.open = false;
        sessions.delete(connectionId);
        const code = disconnectCode(update.lastDisconnect?.error);
        const loggedOut = code === DisconnectReason.loggedOut;
        await setConnection(connectionId, { status: loggedOut ? 'disconnected' : 'reconnecting', last_heartbeat_at: now() });
        log.warn({ connectionId, code, loggedOut }, 'persistent WhatsApp connection closed');
        if (!loggedOut) scheduleReconnect(connectionId, userId, [408, 428, 503, 515].includes(code) ? 1200 : 3500);
      }
    } catch (err) {
      log.error({ connectionId, err: String(err) }, 'connection update handler failed');
    }
  });
  return sock;
}

async function ensureConnections() {
  const { data: rows = [], error } = await db.from('whatsapp_connections').select('id,user_id,status,session_secret_configured').in('status', ['connected', 'reconnecting']);
  if (error) throw error;
  for (const c of rows) {
    if (!c.session_secret_configured || sessions.has(c.id)) continue;
    startConnection(c.id, c.user_id).catch(err => {
      log.error({ connectionId: c.id, err: String(err) }, 'connection restore failed');
      scheduleReconnect(c.id, c.user_id, 5000);
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
    if (!jid) continue;
    const attempts = Number(job.attempts || 0) + 1;
    const { data: locked, error: lockError } = await db.from('whatsapp_outbound_jobs')
      .update({ status: 'processing', started_at: now(), attempts, updated_at: now(), last_error: null })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle();
    if (lockError || !locked) continue;
    try {
      const sent = await session.sock.sendMessage(jid, { text: job.message_text });
      await db.from('whatsapp_outbound_jobs').update({ status: 'sent', sent_at: now(), external_message_id: sent?.key?.id || null, last_error: null, updated_at: now() }).eq('id', job.id);
      if (job.offer_id) await db.from('offers').update({ status: 'published', published_at: now(), updated_at: now() }).eq('id', job.offer_id).eq('user_id', job.user_id);
      await db.from('audit_events').insert({ user_id: job.user_id, event_type: 'offer.sent.whatsapp', entity_type: 'offer', entity_id: job.offer_id, redacted_metadata: { group_ref_id: job.group_ref_id, message_id: sent?.key?.id || null } });
      log.info({ job: job.id, group: job.whatsapp_group_refs?.display_name }, 'WhatsApp job sent');
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 500);
      await db.from('whatsapp_outbound_jobs').update({ status: attempts >= 3 ? 'failed' : 'queued', last_error: msg, updated_at: now() }).eq('id', job.id);
      log.error({ job: job.id, err: msg }, 'WhatsApp job failed');
    }
  }
}
async function heartbeat() {
  for (const [id, s] of sessions) if (s.open) await setConnection(id, { last_heartbeat_at: now() });
}
async function refreshGroups() {
  for (const [id, s] of sessions) if (s.open) await fetchParticipatingGroups(id, s.userId, s.sock, 'periodic');
}

createServer((req, res) => {
  if (req.url !== '/health') { res.writeHead(404); res.end('not found'); return; }
  const open = [...sessions.values()].filter(s => s.open).length;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, open_connections: open, uptime_seconds: Math.round(process.uptime()) }));
}).listen(PORT, '0.0.0.0', () => log.info({ port: PORT }, 'health server listening'));

await ensureConnections();
setInterval(() => ensureConnections().catch(err => log.error({ err: String(err) }, 'ensureConnections failed')), 5000);
setInterval(() => processJobs().catch(err => log.error({ err: String(err) }, 'processJobs failed')), 1500);
setInterval(() => heartbeat().catch(err => log.error({ err: String(err) }, 'heartbeat failed')), 15000);
setInterval(() => refreshGroups().catch(err => log.error({ err: String(err) }, 'periodic group refresh failed')), 5 * 60 * 1000);
log.info('Afilia persistent WhatsApp gateway started');

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down WhatsApp gateway');
  for (const [id, s] of sessions) {
    try { await persistSession(id, s.userId, s.dir); } catch {}
    try { s.sock.end(undefined); } catch {}
  }
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
