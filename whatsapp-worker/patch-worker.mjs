import fs from 'node:fs';

const file = new URL('./worker-v5-media.js', import.meta.url);
let src = fs.readFileSync(file, 'utf8');

if (!src.includes("import sharp from'sharp';")) {
  src = src.replace("import pino from'pino';", "import pino from'pino';import sharp from'sharp';");
}

const oldFetch = "async function fetchOfferImage(url){if(!url)return null;const r=await fetch(String(url),{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Afilia WhatsApp Gateway)','accept':'image/avif,image/webp,image/apng,image/jpeg,image/png,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('image_http_'+r.status);const buffer=Buffer.from(await r.arrayBuffer());if(!buffer.length)throw new Error('image_empty');if(buffer.length>16*1024*1024)throw new Error('image_too_large');return{buffer,mime:String(r.headers.get('content-type')||'image/jpeg').split(';')[0].trim()}}";
const newFetch = "async function fetchOfferImage(url){if(!url)return null;const r=await fetch(String(url),{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Afilia WhatsApp Gateway)','accept':'image/jpeg,image/png,image/webp,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('image_http_'+r.status);const source=Buffer.from(await r.arrayBuffer());if(!source.length)throw new Error('image_empty');if(source.length>16*1024*1024)throw new Error('image_too_large');const sourceMime=String(r.headers.get('content-type')||'application/octet-stream').split(';')[0].trim();const buffer=await sharp(source,{failOn:'none'}).rotate().flatten({background:'#ffffff'}).jpeg({quality:90,mozjpeg:true}).toBuffer();if(!buffer.length)throw new Error('jpeg_normalization_empty');const thumbnail=await sharp(buffer).resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();return{buffer,mime:'image/jpeg',thumbnail,sourceMime,sourceBytes:source.length,normalizedBytes:buffer.length}}";
if (!src.includes(newFetch)) {
  if (!src.includes(oldFetch)) throw new Error('fetchOfferImage signature changed; patch aborted');
  src = src.replace(oldFetch, newFetch);
}

const oldSend = "sent=await s.sock.sendMessage(jid,{image:media.buffer,caption:j.message_text,mimetype:media.mime});deliveryMode='image_caption'";
const newSend = "sent=await s.sock.sendMessage(jid,{image:media.buffer,caption:j.message_text,mimetype:'image/jpeg',jpegThumbnail:media.thumbnail});deliveryMode='image_caption_jpeg'";
if (!src.includes(newSend)) {
  if (!src.includes(oldSend)) throw new Error('media send signature changed; patch aborted');
  src = src.replace(oldSend, newSend);
}

// Keep outgoing messages in processing state until WhatsApp itself acknowledges them.
if (!src.includes('pendingByMessageId=new Map()')) {
  const oldMaps = "const sessions=new Map(),localReady=new Set(),reconnectAt=new Map(),pairResumeMode=new Map();";
  const newMaps = "const sessions=new Map(),localReady=new Set(),reconnectAt=new Map(),pairResumeMode=new Map(),pendingByMessageId=new Map();";
  if (!src.includes(oldMaps)) throw new Error('worker map signature changed; ack patch aborted');
  src = src.replace(oldMaps, newMaps);
}

const pairAnchor = "async function pairAudit(uid,cid,rid,kind,extra={}){return audit(uid,cid,'whatsapp.pair_event',{request_id:rid,kind,...extra})}";
if (!src.includes('async function markAck(')) {
  if (!src.includes(pairAnchor)) throw new Error('pairAudit signature changed; ack patch aborted');
  const ackLogic = `${pairAnchor}\nasync function notifyTelegram(uid,text){try{const token=await secret('platform.telegram.bot_token');const{data:l}=await db.from('telegram_user_links').select('chat_id').eq('user_id',uid).maybeSingle();if(!l?.chat_id)return false;const r=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:l.chat_id,text,disable_web_page_preview:true})});return r.ok}catch(e){log.warn({uid,err:String(e)},'telegram confirmation failed');return false}}\nfunction ackStage(n){return n>=5?'played':n>=4?'read':n>=3?'delivered':n>=2?'server_ack':'accepted'}\nasync function markAck(mid,code,source='messages.update'){const n=Number(code);if(!mid||!Number.isFinite(n)||n<2)return;let job=null;const p=pendingByMessageId.get(mid);if(p){const{data}=await db.from('whatsapp_outbound_jobs').select('id,user_id,connection_id,group_ref_id,offer_id,status,ack_status,confirmation_notified_at').eq('id',p.jobId).maybeSingle();job=data}else{const{data}=await db.from('whatsapp_outbound_jobs').select('id,user_id,connection_id,group_ref_id,offer_id,status,ack_status,confirmation_notified_at').eq('external_message_id',mid).order('created_at',{ascending:false}).limit(1).maybeSingle();job=data}if(!job)return;const t=now(),stage=ackStage(n),patch={status:'sent',sent_at:t,server_acked_at:t,last_ack_code:n,ack_status:stage,last_error:null,updated_at:t};if(n>=3)patch.delivered_at=t;if(n>=4)patch.read_at=t;await db.from('whatsapp_outbound_jobs').update(patch).eq('id',job.id);if(job.offer_id)await db.from('offers').update({status:'published',published_at:t,updated_at:t}).eq('id',job.offer_id).eq('user_id',job.user_id);await db.from('audit_events').insert({user_id:job.user_id,event_type:'offer.whatsapp.ack',entity_type:'offer',entity_id:job.offer_id,redacted_metadata:{job_id:job.id,message_id:mid,ack_code:n,ack_status:stage,source}}).catch(()=>{});if(!job.confirmation_notified_at){const{data:g}=await db.from('whatsapp_group_refs').select('display_name').eq('id',job.group_ref_id).maybeSingle();const ok=await notifyTelegram(job.user_id,'✅ WhatsApp confirmou o envio para '+(g?.display_name||'o grupo')+'.');if(ok)await db.from('whatsapp_outbound_jobs').update({confirmation_notified_at:t}).eq('id',job.id).is('confirmation_notified_at',null)}if(n>=4)pendingByMessageId.delete(mid)}\nfunction wireAcks(sock){sock.ev.on('messages.update',xs=>{for(const x of xs||[]){const id=x?.key?.id,st=Number(x?.update?.status);if(id&&Number.isFinite(st)&&st>=2)markAck(id,st,'messages.update').catch(e=>log.warn({id,st,err:String(e)},'ack update failed'))}});sock.ev.on('message-receipt.update',xs=>{for(const x of xs||[]){const id=x?.key?.id,r=x?.receipt||{},st=r.playedTimestamp?5:r.readTimestamp?4:r.receiptTimestamp?3:0;if(id&&st)markAck(id,st,'message-receipt.update').catch(e=>log.warn({id,st,err:String(e)},'receipt update failed'))}})}`;
  src = src.replace(pairAnchor, ackLogic);
}

if (!src.includes('wireAcks(sock);')) {
  const oldWire = "sessions.set(cid,s);wireDiscovery(cid,uid,sock);";
  const newWire = "sessions.set(cid,s);wireDiscovery(cid,uid,sock);wireAcks(sock);";
  if (!src.includes(oldWire)) throw new Error('socket wiring signature changed; ack patch aborted');
  src = src.replace(oldWire, newWire);
}

const oldLock = "update({status:'processing',started_at:now(),attempts,updated_at:now(),last_error:null})";
const newLock = "update({status:'processing',started_at:now(),attempts,updated_at:now(),last_error:null,ack_status:'none'})";
if (!src.includes(newLock)) {
  if (!src.includes(oldLock)) throw new Error('job lock signature changed; ack patch aborted');
  src = src.replace(oldLock, newLock);
}

const oldSuccess = "await db.from('whatsapp_outbound_jobs').update({status:'sent',sent_at:now(),external_message_id:sent?.key?.id||null,updated_at:now(),last_error:null}).eq('id',j.id);if(j.offer_id)await db.from('offers').update({status:'published',published_at:now(),updated_at:now()}).eq('id',j.offer_id).eq('user_id',j.user_id);await db.from('audit_events').insert({user_id:j.user_id,event_type:'offer.sent.whatsapp',entity_type:'offer',entity_id:j.offer_id,redacted_metadata:{group_ref_id:j.group_ref_id,message_id:sent?.key?.id||null,delivery_mode:deliveryMode,had_image:Boolean(imageUrl),media_error:mediaError}})";
const newSuccess = "const mid=sent?.key?.id||null,t=now();if(!mid)throw new Error('whatsapp_missing_message_id');pendingByMessageId.set(mid,{jobId:j.id});await db.from('whatsapp_outbound_jobs').update({status:'processing',accepted_at:t,ack_status:'accepted',external_message_id:mid,updated_at:t,last_error:null}).eq('id',j.id);await db.from('audit_events').insert({user_id:j.user_id,event_type:'offer.accepted.whatsapp',entity_type:'offer',entity_id:j.offer_id,redacted_metadata:{job_id:j.id,group_ref_id:j.group_ref_id,message_id:mid,delivery_mode:deliveryMode,had_image:Boolean(imageUrl),media_error:mediaError}})";
if (!src.includes(newSuccess)) {
  if (!src.includes(oldSuccess)) throw new Error('job success signature changed; ack patch aborted');
  src = src.replace(oldSuccess, newSuccess);
}

const oldFailure = "update({status:attempts>=3?'failed':'queued',last_error:msg,updated_at:now()})";
const newFailure = "update({status:attempts>=3?'failed':'queued',ack_status:'error',last_error:msg,updated_at:now()})";
if (!src.includes(newFailure) && src.includes(oldFailure)) src = src.replace(oldFailure, newFailure);

if (!src.includes('async function flagUnconfirmed()')) {
  const hb = "async function heartbeat(){for(const[id,s]of sessions)if(s.open)await setConn(id,{last_heartbeat_at:now()})}";
  if (!src.includes(hb)) throw new Error('heartbeat signature changed; ack patch aborted');
  const extra = "async function flagUnconfirmed(){const cutoff=new Date(Date.now()-90000).toISOString();const{data:rows=[]}=await db.from('whatsapp_outbound_jobs').select('id').eq('status','processing').eq('ack_status','accepted').lt('accepted_at',cutoff).is('last_error',null).limit(20);for(const r of rows)await db.from('whatsapp_outbound_jobs').update({last_error:'Aguardando confirmação do WhatsApp; não reenviado para evitar duplicidade.',updated_at:now()}).eq('id',r.id)}\n" + hb;
  src = src.replace(hb, extra);
}

src = src.replace("await hydrateOneGroupName();await processJobs();await heartbeat()", "await hydrateOneGroupName();await processJobs();await flagUnconfirmed();await heartbeat()");
src = src.replace("service:'afilia-whatsapp-worker-v5-media'", "service:'afilia-whatsapp-worker-v6-ack'");
src = src.replace("log.info('Afilia WhatsApp worker v5-media started')", "log.info('Afilia WhatsApp worker v6-ack started')");

fs.writeFileSync(file, src);
console.log('[patch-worker] media normalized + WhatsApp ACK tracking enabled');
