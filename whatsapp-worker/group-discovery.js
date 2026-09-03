import makeWASocket,{Browsers,fetchLatestWaWebVersion,useMultiFileAuthState} from '@whiskeysockets/baileys';
import {createClient} from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import {createDecipheriv,createHash} from 'node:crypto';

const U=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_ROLE_KEY,ROOT=process.env.SESSION_ROOT||'./sessions';
if(!U||!K) throw Error('missing_supabase_env');
const db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}}),log=pino({level:process.env.LOG_LEVEL||'info'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const now=()=>new Date().toISOString();
let sessionKey=null;
async function secret(name){const{data,error}=await db.rpc('service_get_platform_secret',{p_name:name});if(error)throw error;if(!data)throw Error('missing_secret_'+name);return String(data)}
async function key(){if(!sessionKey)sessionKey=createHash('sha256').update(await secret('platform.whatsapp.session_key')).digest();return sessionKey}
async function unseal(v){const[iv64,p64]=String(v||'').split('.');const payload=Buffer.from(p64,'base64'),body=payload.subarray(0,-16),tag=payload.subarray(-16);const d=createDecipheriv('aes-256-gcm',await key(),Buffer.from(iv64,'base64'));d.setAuthTag(tag);return Buffer.concat([d.update(body),d.final()]).toString('utf8')}
async function restore(id,dir){const{data,error}=await db.rpc('service_get_whatsapp_session_blob',{p_connection_id:id});if(error)throw error;if(!data)throw Error('session_blob_missing');const files=JSON.parse(await unseal(data));await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});for(const[n,b]of Object.entries(files)){const f=path.join(dir,n);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,Buffer.from(String(b),'base64'))}}
function jidFrom(v){if(!v)return null;const s=String(v);if(s.endsWith('@g.us'))return s;if(/^\d+(?:-\d+)?$/.test(s))return s+'@g.us';return null}
function collect(node,out=new Set()){if(!node||typeof node!=='object')return out;for(const v of Object.values(node.attrs||{})){const j=jidFrom(v);if(j)out.add(j)}if(node.tag==='group'){const j=jidFrom(node.attrs?.id)||jidFrom(node.attrs?.jid);if(j)out.add(j)}const c=node.content;if(Array.isArray(c))for(const x of c)collect(x,out);return out}
async function saveGroup(conn,user,jid,subject,source){const name=String(subject||'').trim();if(!name)return false;const{data:old}=await db.from('whatsapp_group_refs').select('id,is_enabled').eq('connection_id',conn).eq('external_group_ref',jid).maybeSingle();const patch={display_name:name,name_status:'verified',name_source:source,name_verified_at:now(),last_name_error:null,updated_at:now()};if(old){const{error}=await db.from('whatsapp_group_refs').update(patch).eq('id',old.id);if(error)throw error}else{const{error}=await db.from('whatsapp_group_refs').insert({user_id:user,connection_id:conn,external_group_ref:jid,display_name:name,role:'destination',is_enabled:false,name_status:'verified',name_source:source,name_verified_at:now(),last_name_error:null});if(error)throw error}return true}
async function audit(user,conn,meta){try{await db.from('audit_events').insert({user_id:user,event_type:'whatsapp.active_group_discovery',entity_type:'whatsapp_connection',entity_id:conn,redacted_metadata:{...meta,at:now()}})}catch{}}

const{data:rows,error}=await db.from('whatsapp_connections').select('id,user_id,status,session_secret_configured').in('status',['connected','degraded']).eq('session_secret_configured',true);
if(error)throw error;
for(const row of rows||[]){
  const{count}=await db.from('whatsapp_group_refs').select('*',{count:'exact',head:true}).eq('connection_id',row.id);
  if((count||0)>0)continue;
  const dir=path.join(ROOT,'discover-'+row.id);
  try{
    await restore(row.id,dir);const{state}=await useMultiFileAuthState(dir);const{version}=await fetchLatestWaWebVersion();
    const sock=makeWASocket({auth:state,version,browser:Browsers.ubuntu('Chrome'),logger:log.child({connectionId:row.id}),printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:true,fireInitQueries:true,shouldSyncHistoryMessage:()=>true,keepAliveIntervalMs:20000,connectTimeoutMs:60000,defaultQueryTimeoutMs:60000});
    let opened=false,closedCode=0;
    sock.ev.on('connection.update',u=>{if(u.connection==='open')opened=true;if(u.connection==='close')closedCode=Number(u.lastDisconnect?.error?.output?.statusCode||u.lastDisconnect?.error?.statusCode||0)});
    for(let i=0;i<40&&!opened&&!closedCode;i++)await wait(500);
    if(!opened)throw Error('socket_not_open_'+closedCode);
    await db.from('whatsapp_connections').update({status:'connected',last_heartbeat_at:now(),updated_at:now()}).eq('id',row.id);
    const candidates=new Set();let officialCount=0,rawCount=0,officialError=null,rawError=null;
    try{const groups=await sock.groupFetchAllParticipating();for(const [jid,m] of Object.entries(groups||{})){const j=jidFrom(jid)||jidFrom(m?.id);if(j){candidates.add(j);if(m?.subject)await saveGroup(row.id,row.user_id,j,m.subject,'groupFetchAllParticipating')}}officialCount=Object.keys(groups||{}).length}catch(e){officialError=String(e?.message||e)}
    if(!closedCode){try{const raw=await sock.query({tag:'iq',attrs:{to:'@g.us',xmlns:'w:g2',type:'get'},content:[{tag:'participating',attrs:{},content:[{tag:'participants',attrs:{}},{tag:'description',attrs:{}}]}]});const rawSet=collect(raw);for(const j of rawSet)candidates.add(j);rawCount=rawSet.size}catch(e){rawError=String(e?.message||e)}}
    let verified=0,failed=0;
    for(const jid of candidates){try{const meta=await sock.groupMetadata(jid);if(await saveGroup(row.id,row.user_id,jid,meta?.subject,'groupMetadata_active'))verified++;else failed++}catch(e){failed++;try{await db.from('audit_events').insert({user_id:row.user_id,event_type:'whatsapp.group_name_probe',entity_type:'whatsapp_connection',entity_id:row.id,redacted_metadata:{jid,status:'failed',error:String(e?.message||e).slice(0,180),at:now()}})}catch{}}await wait(350)}
    await audit(row.user_id,row.id,{official_count:officialCount,raw_count:rawCount,candidates:candidates.size,verified,failed,official_error:officialError,raw_error:rawError,closed_code:closedCode});
    log.info({connectionId:row.id,officialCount,rawCount,candidates:candidates.size,verified,failed,closedCode},'active discovery complete');
    try{sock.end(undefined)}catch{}
  }catch(e){await audit(row.user_id,row.id,{fatal_error:String(e?.message||e).slice(0,220)});log.error({connectionId:row.id,err:String(e)},'active discovery failed')}
}
log.info('active group discovery finished');
await wait(300000);
