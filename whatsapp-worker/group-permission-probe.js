import makeWASocket,{Browsers,fetchLatestWaWebVersion,useMultiFileAuthState}from'@whiskeysockets/baileys';
import{createClient}from'@supabase/supabase-js';
import pino from'pino';
import fs from'node:fs/promises';import path from'node:path';
import{createDecipheriv,createHash}from'node:crypto';
const U=process.env.SUPABASE_URL,K=process.env.SUPABASE_SERVICE_ROLE_KEY,ROOT=process.env.SESSION_ROOT||'./sessions';
if(!U||!K)throw new Error('missing env');
const db=createClient(U,K,{auth:{persistSession:false,autoRefreshToken:false}}),log=pino({level:'warn'});let sessionKey=null;
const secret=async n=>{const{data,error}=await db.rpc('service_get_platform_secret',{p_name:n});if(error)throw error;return String(data)};
const key=async()=>sessionKey||(sessionKey=createHash('sha256').update(await secret('platform.whatsapp.session_key')).digest());
const unseal=async v=>{const[a,b]=String(v||'').split('.'),p=Buffer.from(b,'base64'),d=createDecipheriv('aes-256-gcm',await key(),Buffer.from(a,'base64'));d.setAuthTag(p.subarray(-16));return Buffer.concat([d.update(p.subarray(0,-16)),d.final()]).toString('utf8')};
const{data:c}=await db.from('whatsapp_connections').select('id,user_id').eq('status','connected').order('last_heartbeat_at',{ascending:false}).limit(1).single();
const{data:blob}=await db.rpc('service_get_whatsapp_session_blob',{p_connection_id:c.id});const dir=path.join(ROOT,'perm-probe-'+c.id);await fs.rm(dir,{recursive:true,force:true});await fs.mkdir(dir,{recursive:true});for(const[n,b64]of Object.entries(JSON.parse(await unseal(blob)))){const p=path.join(dir,n);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,Buffer.from(String(b64),'base64'))}
const{state}=await useMultiFileAuthState(dir),{version}=await fetchLatestWaWebVersion();const sock=makeWASocket({auth:state,version,logger:log,browser:Browsers.ubuntu('Chrome'),markOnlineOnConnect:false,syncFullHistory:false,fireInitQueries:false});
const wait=ms=>new Promise(r=>setTimeout(r,ms));let open=false;sock.ev.on('connection.update',u=>{if(u.connection==='open')open=true});for(let i=0;i<40&&!open;i++)await wait(500);if(!open)throw new Error('probe_socket_not_open');
const jid='120363406605107311@g.us',meta=await sock.groupMetadata(jid);const me=String(sock.user?.id||''),meBase=me.split(':')[0];const participants=(meta?.participants||[]).map(p=>({id:String(p.id||''),admin:p.admin||null}));const self=participants.find(p=>p.id===me||p.id.startsWith(meBase+'@')||p.id.split('@')[0]===meBase)||null;await db.from('audit_events').insert({user_id:c.user_id,event_type:'whatsapp.group_permission_probe',entity_type:'whatsapp_connection',entity_id:c.id,redacted_metadata:{jid,subject:meta?.subject||null,announce:meta?.announce??null,restrict:meta?.restrict??null,participant_count:participants.length,self_admin:self?.admin||null,self_found:Boolean(self),user_id_hint:meBase.slice(-4)}});try{sock.end(undefined)}catch{}await fs.rm(dir,{recursive:true,force:true});process.exit(0);
