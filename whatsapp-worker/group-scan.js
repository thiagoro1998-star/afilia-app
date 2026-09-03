import makeWASocket,{Browsers,fetchLatestWaWebVersion,useMultiFileAuthState}from'@whiskeysockets/baileys';
import{createClient}from'@supabase/supabase-js';
import pino from'pino';
import fs from'node:fs/promises';import path from'node:path';
import{createDecipheriv,createHash}from'node:crypto';
import{createServer}from'node:http';

const U=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_ROLE_KEY,ROOT=process.env.SESSION_ROOT||'./sessions',PORT=Number(process.env.PORT||8080);
if(!U||!K)throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}}),log=pino({level:process.env.LOG_LEVEL||'info'});
const wait=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date().toISOString(),codeOf=e=>Number(e?.output?.statusCode||e?.statusCode||e?.data?.statusCode||0);
let sessionKey=null,current={status:'booting',connectionId:null,found:null,last:null};
await fs.mkdir(ROOT,{recursive:true});
async function secret(n){const{data,error}=await db.rpc('service_get_platform_secret',{p_name:n});if(error)throw error;if(!data)throw new Error('missing '+n);return String(data)}
async function key(){if(!sessionKey)sessionKey=createHash('sha256').update(await secret('platform.whatsapp.session_key')).digest();return sessionKey}
async function unseal(v){const[a,b]=String(v||'').split('.');if(!a||!b)throw new Error('invalid_session_blob');const p=Buffer.from(b,'base64'),d=createDecipheriv('aes-256-gcm',await key(),Buffer.from(a,'base64'));d.setAuthTag(p.subarray(-16));return Buffer.concat([d.update(p.subarray(0,-16)),d.final()]).toString('utf8')}
async function restore(cid){const{data,error}=await db.rpc('service_get_whatsapp_session_blob',{p_connection_id:cid});if(error)throw error;if(!data)throw new Error('session_not_found');const dir=path.join(ROOT,'scan-'+cid);await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});const files=JSON.parse(await unseal(String(data)));for(const[n,b64]of Object.entries(files)){const p=path.join(dir,n);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,Buffer.from(String(b64),'base64'))}return dir}
async function target(){const{data:rows,error}=await db.from('whatsapp_connections').select('id,user_id,status,session_secret_configured').eq('status','connected').eq('session_secret_configured',true).order('last_connected_at',{ascending:false});if(error)throw error;for(const c of rows||[]){const{count}=await db.from('whatsapp_group_refs').select('*',{head:true,count:'exact'}).eq('connection_id',c.id);if((count||0)===0)return c}return null}
async function audit(uid,cid,meta){try{await db.from('audit_events').insert({user_id:uid,event_type:'whatsapp.group_scan',entity_type:'whatsapp_connection',entity_id:cid,redacted_metadata:{...meta,at:now()}})}catch{}}
async function upsert(c,g){const jid=String(g?.id||'');const subject=String(g?.subject||'').trim();if(!jid.endsWith('@g.us'))return;const{data:old}=await db.from('whatsapp_group_refs').select('id').eq('connection_id',c.id).eq('external_group_ref',jid).maybeSingle();const payload={display_name:subject||'Grupo WhatsApp',role:'destination',is_enabled:false,name_status:subject?'verified':'pending',name_source:subject?'groupFetchAllParticipating':'scan',name_verified_at:subject?now():null,last_name_error:null,updated_at:now()};if(old)await db.from('whatsapp_group_refs').update(payload).eq('id',old.id);else await db.from('whatsapp_group_refs').insert({user_id:c.user_id,connection_id:c.id,external_group_ref:jid,...payload});}
function timeout(p,ms){return Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout_'+ms)),ms))])}
async function scan(c){current.connectionId=c.id;current.status='restoring';const dir=await restore(c.id);const{state,saveCreds}=await useMultiFileAuthState(dir),{version}=await fetchLatestWaWebVersion();let opened=false,closed=false,closeCode=0;const seen={chatIds:new Set(),messageJids:new Set()};
const sock=makeWASocket({auth:state,version,logger:log.child({scan:c.id}),browser:Browsers.ubuntu('Chrome'),printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:true,fireInitQueries:true,shouldSyncHistoryMessage:()=>true,keepAliveIntervalMs:20000,connectTimeoutMs:60000,defaultQueryTimeoutMs:20000});
sock.ev.on('creds.update',()=>saveCreds().catch(()=>{}));
sock.ev.on('messaging-history.set',e=>{for(const x of e?.chats||[])if(x?.id)seen.chatIds.add(String(x.id));for(const m of e?.messages||[]){if(m?.key?.remoteJid)seen.messageJids.add(String(m.key.remoteJid));if(m?.key?.remoteJidAlt)seen.messageJids.add(String(m.key.remoteJidAlt))}});
sock.ev.on('connection.update',u=>{if(u.connection==='open')opened=true;if(u.connection==='close'){closed=true;closeCode=codeOf(u.lastDisconnect?.error)}});
for(let i=0;i<35&&!opened&&!closed;i++)await wait(1000);if(!opened){await audit(c.user_id,c.id,{stage:'open_failed',closeCode});try{sock.end(undefined)}catch{}throw new Error('scan_socket_not_open_'+closeCode)}
current.status='collecting_history';await wait(8000);await audit(c.user_id,c.id,{stage:'history_ids',chat_ids:[...seen.chatIds].slice(0,80),message_jids:[...seen.messageJids].slice(0,120),chat_count:seen.chatIds.size,message_jid_count:seen.messageJids.size});
current.status='enumerating';try{const all=await timeout(sock.groupFetchAllParticipating(),25000);const groups=Object.values(all||{});current.found=groups.length;for(const g of groups)await upsert(c,g);await audit(c.user_id,c.id,{stage:'group_fetch_success',count:groups.length,jids:groups.map(g=>String(g?.id||'')).slice(0,100)});log.info({count:groups.length},'group scan success')}catch(e){const msg=String(e?.message||e);await audit(c.user_id,c.id,{stage:'group_fetch_failed',error:msg.slice(0,250),closed,closeCode});log.warn({err:msg,closed,closeCode},'group scan failed')}
try{sock.end(undefined)}catch{}current.status='complete';}
async function main(){for(;;){try{const c=await target();if(!c){current.status='nothing_to_scan';await wait(15000);continue}await scan(c);await wait(60000)}catch(e){current.status='error';current.last=String(e?.message||e);log.error({err:String(e)},'scan error');await wait(10000)}}}
createServer((req,res)=>{res.setHeader('content-type','application/json');res.writeHead(200);res.end(JSON.stringify({ok:true,service:'afilia-group-scan',...current,at:now()}))}).listen(PORT,'0.0.0.0',()=>log.info({PORT},'group scan health'));
main();
