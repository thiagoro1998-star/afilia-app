import makeWASocket,{DisconnectReason,fetchLatestBaileysVersion,useMultiFileAuthState}from'@whiskeysockets/baileys';
import{createClient}from'@supabase/supabase-js';
import pino from'pino';
import fs from'node:fs/promises';
import path from'node:path';

const SUPABASE_URL=process.env.SUPABASE_URL;
const SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE_KEY;
const ROOT=process.env.SESSION_ROOT||'./sessions';
if(!SUPABASE_URL||!SERVICE_ROLE)throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db=createClient(SUPABASE_URL,SERVICE_ROLE,{auth:{persistSession:false}});
const log=pino({level:process.env.LOG_LEVEL||'info'});
const sessions=new Map();
await fs.mkdir(ROOT,{recursive:true});

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function setConnection(id,patch){await db.from('whatsapp_connections').update({...patch,updated_at:new Date().toISOString()}).eq('id',id)}
async function setPair(id,patch){await db.from('whatsapp_pairing_requests').update({...patch,updated_at:new Date().toISOString()}).eq('id',id)}
async function syncGroups(connectionId,userId,sock){
  try{
    const groups=await sock.groupFetchAllParticipating();
    const rows=Object.values(groups).map(g=>({user_id:userId,connection_id:connectionId,external_group_ref:g.id,display_name:g.subject||'Grupo WhatsApp',role:'destination',is_enabled:true,updated_at:new Date().toISOString()}));
    for(const row of rows){
      const{data:existing}=await db.from('whatsapp_group_refs').select('id,is_enabled').eq('user_id',userId).eq('connection_id',connectionId).eq('external_group_ref',row.external_group_ref).maybeSingle();
      if(existing)await db.from('whatsapp_group_refs').update({display_name:row.display_name,updated_at:row.updated_at}).eq('id',existing.id);
      else await db.from('whatsapp_group_refs').insert(row);
    }
    log.info({connectionId,count:rows.length},'groups synced');
  }catch(e){log.error({connectionId,err:String(e)},'group sync failed')}
}
async function startConnection(connectionId,userId,pairRequestId=null){
  if(sessions.has(connectionId))return sessions.get(connectionId).sock;
  const dir=path.join(ROOT,connectionId);
  await fs.mkdir(dir,{recursive:true});
  const{state,saveCreds}=await useMultiFileAuthState(dir);
  const{version}=await fetchLatestBaileysVersion();
  const sock=makeWASocket({auth:state,version,logger:log.child({connectionId}),printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:false});
  const stateObj={sock,userId,open:false,pairRequestId};
  sessions.set(connectionId,stateObj);
  sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async u=>{
    try{
      const{connection,lastDisconnect,qr}=u;
      if(qr&&pairRequestId)await setPair(pairRequestId,{status:'qr_ready',qr_payload:qr});
      if(connection==='open'){
        stateObj.open=true;
        const me=sock.user?.id||'';
        const masked=me?`***${me.replace(/\D/g,'').slice(-4)}`:null;
        await setConnection(connectionId,{status:'connected',phone_masked:masked,session_secret_configured:true,last_connected_at:new Date().toISOString(),last_heartbeat_at:new Date().toISOString()});
        if(pairRequestId)await setPair(pairRequestId,{status:'connected',qr_payload:null});
        await syncGroups(connectionId,userId,sock);
      }
      if(connection==='close'){
        stateObj.open=false;
        sessions.delete(connectionId);
        const code=lastDisconnect?.error?.output?.statusCode||lastDisconnect?.error?.statusCode;
        const loggedOut=code===DisconnectReason.loggedOut;
        await setConnection(connectionId,{status:loggedOut?'disconnected':'reconnecting',last_heartbeat_at:new Date().toISOString()});
        if(loggedOut&&pairRequestId)await setPair(pairRequestId,{status:'failed',qr_payload:null,error_message:'WhatsApp desconectado'});
        if(!loggedOut)setTimeout(()=>startConnection(connectionId,userId,null).catch(e=>log.error(e)),2500);
      }
    }catch(e){log.error({connectionId,err:String(e)},'connection update failed')}
  });
  return sock;
}
async function consumePairings(){
  const{data:reqs=[]}=await db.from('whatsapp_pairing_requests').select('id,user_id,connection_id,expires_at').eq('status','waiting_gateway').order('created_at').limit(10);
  for(const p of reqs){
    if(new Date(p.expires_at)<new Date()){await setPair(p.id,{status:'expired'});continue}
    try{await startConnection(p.connection_id,p.user_id,p.id)}catch(e){log.error({pair:p.id,err:String(e)},'pairing start failed');await setPair(p.id,{status:'failed',error_message:'gateway_error'})}
  }
}
async function restoreConnections(){
  const{data:connections=[]}=await db.from('whatsapp_connections').select('id,user_id,status').in('status',['connected','reconnecting']);
  for(const c of connections)startConnection(c.id,c.user_id,null).catch(e=>log.error({connection:c.id,err:String(e)},'restore failed'));
}
async function processJobs(){
  const{data:jobs=[]}=await db.from('whatsapp_outbound_jobs').select('id,user_id,connection_id,group_ref_id,offer_id,message_text,attempts,whatsapp_group_refs(external_group_ref,display_name)').eq('status','queued').order('created_at').limit(20);
  for(const job of jobs){
    const s=sessions.get(job.connection_id);
    if(!s?.open)continue;
    const jid=job.whatsapp_group_refs?.external_group_ref;
    if(!jid)continue;
    const started=new Date().toISOString();
    const lock=await db.from('whatsapp_outbound_jobs').update({status:'processing',started_at:started,attempts:(job.attempts||0)+1,updated_at:started}).eq('id',job.id).eq('status','queued').select('id').maybeSingle();
    if(!lock.data)continue;
    try{
      const sent=await s.sock.sendMessage(jid,{text:job.message_text});
      await db.from('whatsapp_outbound_jobs').update({status:'sent',sent_at:new Date().toISOString(),external_message_id:sent?.key?.id||null,last_error:null,updated_at:new Date().toISOString()}).eq('id',job.id);
      await db.from('offers').update({status:'published',published_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',job.offer_id).eq('user_id',job.user_id);
      await db.from('audit_events').insert({user_id:job.user_id,event_type:'offer.sent.whatsapp',entity_type:'offer',entity_id:job.offer_id,redacted_metadata:{group_ref_id:job.group_ref_id}});
      log.info({job:job.id,group:job.whatsapp_group_refs?.display_name},'whatsapp sent');
    }catch(e){
      const msg=String(e?.message||e).slice(0,500);
      const next=(job.attempts||0)+1>=3?'failed':'queued';
      await db.from('whatsapp_outbound_jobs').update({status:next,last_error:msg,updated_at:new Date().toISOString()}).eq('id',job.id);
      log.error({job:job.id,err:msg},'whatsapp send failed');
    }
  }
}
async function heartbeat(){for(const[id,s]of sessions)if(s.open)await setConnection(id,{last_heartbeat_at:new Date().toISOString()})}

await restoreConnections();
log.info('Afilia WhatsApp gateway started');
for(;;){
  try{await consumePairings();await processJobs();if(Date.now()%30000<2500)await heartbeat()}catch(e){log.error({err:String(e)},'worker loop failed')}
  await wait(2000);
}
