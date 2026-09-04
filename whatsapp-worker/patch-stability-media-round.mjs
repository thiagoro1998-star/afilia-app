import fs from 'node:fs';

const file = new URL('./worker-v5-media.js', import.meta.url);
let src = fs.readFileSync(file, 'utf8');

// 1) Add small in-memory media cache and session-persist timers.
const mapsOld = "const sessions=new Map(),localReady=new Set(),reconnectAt=new Map(),pairResumeMode=new Map(),pendingByMessageId=new Map();";
const mapsNew = "const sessions=new Map(),localReady=new Set(),reconnectAt=new Map(),pairResumeMode=new Map(),pendingByMessageId=new Map(),mediaCache=new Map(),lastSessionPersistAt=new Map();let lastOrphanCheckAt=0;";
if (!src.includes(mapsNew)) {
  if (!src.includes(mapsOld)) throw new Error('runtime maps signature changed; reliability patch aborted');
  src = src.replace(mapsOld, mapsNew);
}

// 2) Retry Shopee/CDN image downloads and cache normalized JPEGs for repeated group sends.
const fetchOld = "async function fetchOfferImage(url){if(!url)return null;const r=await fetch(String(url),{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Afilia WhatsApp Gateway)','accept':'image/jpeg,image/png,image/webp,image/*,*/*;q=0.8'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('image_http_'+r.status);const source=Buffer.from(await r.arrayBuffer());if(!source.length)throw new Error('image_empty');if(source.length>16*1024*1024)throw new Error('image_too_large');const sourceMime=String(r.headers.get('content-type')||'application/octet-stream').split(';')[0].trim();const buffer=await sharp(source,{failOn:'none'}).rotate().flatten({background:'#ffffff'}).jpeg({quality:90,mozjpeg:true}).toBuffer();if(!buffer.length)throw new Error('jpeg_normalization_empty');const thumbnail=await sharp(buffer).resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();return{buffer,mime:'image/jpeg',thumbnail,sourceMime,sourceBytes:source.length,normalizedBytes:buffer.length}}";
const fetchNew = "async function fetchOfferImage(url){if(!url)return null;const key=String(url),cached=mediaCache.get(key);if(cached&&Date.now()-cached.at<900000)return cached.value;let lastErr=null;for(let attempt=1;attempt<=3;attempt++){try{const headers={'user-agent':attempt===3?'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36','accept':'image/jpeg,image/png,image/webp,image/avif,image/*,*/*;q=0.8'};if(attempt!==2)headers.referer='https://shopee.com.br/';const r=await fetch(key,{redirect:'follow',headers,signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('image_http_'+r.status);const source=Buffer.from(await r.arrayBuffer());if(!source.length)throw new Error('image_empty');if(source.length>16*1024*1024)throw new Error('image_too_large');const sourceMime=String(r.headers.get('content-type')||'application/octet-stream').split(';')[0].trim();if(sourceMime&&!sourceMime.startsWith('image/')&&sourceMime!=='application/octet-stream')throw new Error('image_bad_content_type_'+sourceMime);const buffer=await sharp(source,{failOn:'none'}).rotate().flatten({background:'#ffffff'}).jpeg({quality:90,mozjpeg:true}).toBuffer();if(!buffer.length)throw new Error('jpeg_normalization_empty');const thumbnail=await sharp(buffer).resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();const value={buffer,mime:'image/jpeg',thumbnail,sourceMime,sourceBytes:source.length,normalizedBytes:buffer.length};mediaCache.set(key,{at:Date.now(),value});if(mediaCache.size>80)mediaCache.delete(mediaCache.keys().next().value);return value}catch(e){lastErr=e;if(attempt<3)await wait(700*attempt)}}throw new Error('image_fetch_failed:'+String(lastErr?.message||lastErr).slice(0,160))}";
if (!src.includes(fetchNew)) {
  if (!src.includes(fetchOld)) throw new Error('normalized media fetch signature changed; reliability patch aborted');
  src = src.replace(fetchOld, fetchNew);
}

// 3) Include job creation time so slow product enrichment can wait for image instead of sending text/failing immediately.
const selectOld = ".select('id,user_id,connection_id,group_ref_id,offer_id,message_text,attempts,media_message_id,media_sent_at,delivery_mode,media_error,whatsapp_group_refs(external_group_ref,display_name),offers(image_url,product_title)')";
const selectNew = ".select('id,user_id,connection_id,group_ref_id,offer_id,message_text,attempts,created_at,media_message_id,media_sent_at,delivery_mode,media_error,whatsapp_group_refs(external_group_ref,display_name),offers(image_url,product_title)')";
if (!src.includes(selectNew)) {
  if (!src.includes(selectOld)) throw new Error('strict media select signature changed; reliability patch aborted');
  src = src.replace(selectOld, selectNew);
}

const noImageOld = "if(!imageUrl)throw new Error('offer_image_required');try{";
const noImageNew = "if(!imageUrl){const ageMs=Date.now()-new Date(j.created_at||0).getTime();if(Number.isFinite(ageMs)&&ageMs<120000){await db.from('whatsapp_outbound_jobs').update({status:'queued',attempts:Math.max(0,attempts-1),ack_status:'none',last_error:'Aguardando imagem do produto para envio completo.',updated_at:now()}).eq('id',j.id);continue}throw new Error('offer_image_unavailable_after_wait')}try{";
if (!src.includes(noImageNew)) {
  if (!src.includes(noImageOld)) throw new Error('required-image gate signature changed; reliability patch aborted');
  src = src.replace(noImageOld, noImageNew);
}

// 4) Once WhatsApp returned a real media message id, never requeue that job because of later bookkeeping/audit errors.
const failureOld = "catch(e){const msg=String(e?.message||e).slice(0,500);await db.from('whatsapp_outbound_jobs').update({status:attempts>=3?'failed':'queued',ack_status:'error',last_error:msg,updated_at:now()}).eq('id',j.id)}}}";
const failureNew = "catch(e){const msg=String(e?.message||e).slice(0,500);if(j.media_message_id){const t=now();pendingByMessageId.set(j.media_message_id,{jobId:j.id});await db.from('whatsapp_outbound_jobs').update({status:'processing',ack_status:'accepted',accepted_at:t,external_message_id:j.media_message_id,last_error:null,updated_at:t}).eq('id',j.id);await db.from('audit_events').insert({user_id:j.user_id,event_type:'offer.post_send.bookkeeping_recovered',entity_type:'offer',entity_id:j.offer_id,redacted_metadata:{job_id:j.id,group_ref_id:j.group_ref_id,message_id:j.media_message_id,error:msg}}).catch(()=>{});continue}await db.from('whatsapp_outbound_jobs').update({status:attempts>=3?'failed':'queued',ack_status:'error',last_error:msg,updated_at:now()}).eq('id',j.id)}}}";
if (!src.includes(failureNew)) {
  if (!src.includes(failureOld)) throw new Error('job failure signature changed; anti-duplicate patch aborted');
  src = src.replace(failureOld, failureNew);
}

// 5) Periodically persist live linked-device credentials. Shared/shadow connections are excluded from orphan cleanup.
const hb = "async function heartbeat(){for(const[id,s]of sessions)if(s.open)await setConn(id,{last_heartbeat_at:now()})}";
const durability = `${hb}\nasync function ensureSessionPersistence(){for(const[id,s]of sessions){if(!s.open||!s.registered)continue;const last=lastSessionPersistAt.get(id)||0;if(Date.now()-last<180000)continue;try{await persist(id,s.userId,s.dir);lastSessionPersistAt.set(id,Date.now());await setConn(id,{session_secret_configured:true})}catch(e){log.error({cid:id,err:String(e)},'periodic session persistence failed');await audit(s.userId,id,'whatsapp.session_persist_failed',{error:String(e?.message||e).slice(0,180)})}}}\nasync function repairOrphanConnectionStates(){if(Date.now()-lastOrphanCheckAt<30000)return;lastOrphanCheckAt=Date.now();const{data:rows=[],error}=await db.from('whatsapp_connections').select('id,user_id,last_heartbeat_at,shared_from_connection_id').in('status',['connected','degraded']).eq('session_secret_configured',false);if(error)throw error;const cutoff=Date.now()-120000;for(const r of rows){if(r.shared_from_connection_id||sessions.has(r.id))continue;const beat=r.last_heartbeat_at?new Date(r.last_heartbeat_at).getTime():0;if(!beat||beat<cutoff){await setConn(r.id,{status:'disconnected'});await audit(r.user_id,r.id,'whatsapp.orphan_connection_repaired',{reason:'connected_without_persisted_session'})}}}`;
if (!src.includes('async function ensureSessionPersistence()')) {
  if (!src.includes(hb)) throw new Error('heartbeat signature changed; durability patch aborted');
  src = src.replace(hb, durability);
}

const loopOld = "await flagUnconfirmed();await heartbeat()";
const loopNew = "await flagUnconfirmed();await ensureSessionPersistence();await repairOrphanConnectionStates();await heartbeat()";
if (!src.includes(loopNew)) {
  if (!src.includes(loopOld)) throw new Error('worker loop signature changed; durability patch aborted');
  src = src.replace(loopOld, loopNew);
}

src = src.replace("service:'afilia-whatsapp-worker-v9-verified-image'", "service:'afilia-whatsapp-worker-v10-stable-media'");
src = src.replace("log.info('Afilia WhatsApp worker v9-verified-image started')", "log.info('Afilia WhatsApp worker v10-stable-media started')");

fs.writeFileSync(file, src);
console.log('[patch-stability-media-round] retries/cache + media wait + anti-duplicate + session durability enabled');
