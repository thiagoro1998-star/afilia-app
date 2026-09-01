import makeWASocket,{Browsers,DisconnectReason,fetchLatestWaWebVersion,useMultiFileAuthState}from'@whiskeysockets/baileys';
import{createClient}from'@supabase/supabase-js';
import pino from'pino';
import fs from'node:fs/promises';import path from'node:path';
import{createDecipheriv,createHash}from'node:crypto';
import{createServer}from'node:http';

const U=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_ROLE_KEY,ROOT=process.env.SESSION_ROOT||'./sessions',PORT=Number(process.env.PORT||8080);
if(!U||!K)throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}}),log=pino({level:process.env.LOG_LEVEL||'info'});
const wait=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date().toISOString(),codeOf=e=>Number(e?.output?.statusCode||e?.statusCode||e?.data?.statusCode||0);
let sessionKey=null,current={status:'booting',connectionId:null,remaining:null,last:null};
await fs.mkdir(ROOT,{recursive:true});

async function secret(n){const{data,error}=await db.rpc('service_get_platform_secret',{p_name:n});if(error)throw error;if(!data)throw new Error('missing '+n);return String(data)}
async function key(){if(!sessionKey)sessionKey=createHash('sha256').update(await secret('platform.whatsapp.session_key')).digest();return sessionKey}
async function unseal(v){const[a,b]=String(v||'').split('.');if(!a||!b)throw new Error('invalid_session_blob');const p=Buffer.from(b,'base64'),d=createDecipheriv('aes-256-gcm',await key(),Buffer.from(a,'base64'));d.setAuthTag(p.subarray(-16));return Buffer.concat([d.update(p.subarray(0,-16)),d.final()]).toString('utf8')}
async function restore(cid){const{data,error}=await db.rpc('service_get_whatsapp_session_blob',{p_connection_id:cid});if(error)throw error;if(!data)throw new Error('session_not_found');const dir=path.join(ROOT,'resolver-'+cid);await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});const files=JSON.parse(await unseal(String(data)));for(const[n,b64]of Object.entries(files)){const p=path.join(dir,n);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,Buffer.from(String(b64),'base64'))}return dir}
async function audit(uid,cid,jid,status,extra={}){try{await db.from('audit_events').insert({user_id:uid,event_type:'whatsapp.group_name_probe',entity_type:'whatsapp_connection',entity_id:cid,redacted_metadata:{jid,status,...extra,at:now()}})}catch{}}
async function target(){const{data:pending,error}=await db.from('whatsapp_group_refs').select('connection_id').in('name_status',['pending','failed']).limit(500);if(error)throw error;if(!pending?.length)return null;const counts=new Map();for(const r of pending)counts.set(r.connection_id,(counts.get(r.connection_id)||0)+1);const cid=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0];const{data:c,error:e}=await db.from('whatsapp_connections').select('id,user_id,status,session_secret_configured').eq('id',cid).maybeSingle();if(e)throw e;if(!c?.session_secret_configured)return null;return c}
async function unresolved(cid){const{data,error}=await db.from('whatsapp_group_refs').select('id,external_group_ref,display_name,name_status').eq('connection_id',cid).in('name_status',['pending','failed']).order('created_at');if(error)throw error;return data||[]}
async function markSuccess(g,subject){const{error}=await db.from('whatsapp_group_refs').update({display_name:subject,name_status:'verified',name_source:'groupMetadata',name_verified_at:now(),last_name_error:null,updated_at:now()}).eq('id',g.id);if(error)throw error}
async function markFailure(g,msg){const{error}=await db.from('whatsapp_group_refs').update({name_status:'failed',last_name_error:String(msg).slice(0,300),updated_at:now()}).eq('id',g.id);if(error)throw error}
function withTimeout(p,ms){return Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error('metadata_timeout_'+ms)),ms))])}

async function resolveOnce(c){current.connectionId=c.id;current.status='restoring';const dir=await restore(c.id);const{state,saveCreds}=await useMultiFileAuthState(dir),{version}=await fetchLatestWaWebVersion();let opened=false,closed=false,closeCode=0;
const sock=makeWASocket({auth:state,version,logger:log.child({resolver:c.id}),browser:Browsers.ubuntu('Chrome'),printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:false,fireInitQueries:true,keepAliveIntervalMs:20000,connectTimeoutMs:60000,defaultQueryTimeoutMs:15000});
sock.ev.on('creds.update',()=>saveCreds().catch(()=>{}));
sock.ev.on('connection.update',u=>{if(u.connection==='open')opened=true;if(u.connection==='close'){closed=true;closeCode=codeOf(u.lastDisconnect?.error)}});
for(let i=0;i<30&&!opened&&!closed;i++)await wait(1000);if(!opened){try{sock.end(undefined)}catch{}throw new Error('resolver_socket_not_open_'+closeCode)}
current.status='resolving';const groups=await unresolved(c.id);current.remaining=groups.length;let success=0,failed=0;
for(const g of groups){if(closed)break;current.last=g.external_group_ref;try{const m=await withTimeout(sock.groupMetadata(g.external_group_ref),12000);const subject=String(m?.subject||'').trim();if(!subject)throw new Error('metadata_without_subject');await markSuccess(g,subject);await audit(c.user_id,c.id,g.external_group_ref,'verified',{subject_length:subject.length});success++;log.info({jid:g.external_group_ref,subject},'group name verified')}catch(e){const msg=String(e?.message||e);await markFailure(g,msg);await audit(c.user_id,c.id,g.external_group_ref,'failed',{error:msg.slice(0,180)});failed++;log.warn({jid:g.external_group_ref,err:msg},'group name failed')}current.remaining--;await wait(2500)}
try{sock.end(undefined)}catch{}current.status='round_complete';return{success,failed,closed,closeCode}}

async function main(){for(;;){try{const c=await target();if(!c){current.status='nothing_pending';await wait(15000);continue}const r=await resolveOnce(c);log.info(r,'name resolver round complete');current.status='cooldown';await wait(r.failed?20000:60000)}catch(e){current.status='error';current.last=String(e?.message||e);log.error({err:String(e)},'name resolver error');await wait(10000)}}}
createServer((req,res)=>{res.setHeader('content-type','application/json');res.writeHead(200);res.end(JSON.stringify({ok:true,service:'afilia-group-name-resolver',...current,at:now()}))}).listen(PORT,'0.0.0.0',()=>log.info({PORT},'resolver health server'));
main();
