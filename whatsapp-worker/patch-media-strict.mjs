import fs from 'node:fs';

const file = new URL('./worker-v5-media.js', import.meta.url);
let src = fs.readFileSync(file, 'utf8');

const oldSelect = ".select('id,user_id,connection_id,group_ref_id,offer_id,message_text,attempts,whatsapp_group_refs(external_group_ref,display_name),offers(image_url,product_title)')";
const newSelect = ".select('id,user_id,connection_id,group_ref_id,offer_id,message_text,attempts,media_message_id,media_sent_at,delivery_mode,media_error,whatsapp_group_refs(external_group_ref,display_name),offers(image_url,product_title)')";
if (!src.includes(newSelect)) {
  if (!src.includes(oldSelect)) throw new Error('processJobs select signature changed; strict media patch aborted');
  src = src.replace(oldSelect, newSelect);
}

// Product offers are atomic: image + rendered template must be one WhatsApp message.
// No text-only fallback is allowed when an offer is missing media or media delivery fails.
const oldMedia = "if(imageUrl){try{const media=await fetchOfferImage(imageUrl);sent=await s.sock.sendMessage(jid,{image:media.buffer,caption:j.message_text,mimetype:'image/jpeg',jpegThumbnail:media.thumbnail});deliveryMode='image_caption_jpeg'}catch(e){mediaError=String(e?.message||e).slice(0,220);log.warn({jobId:j.id,jid,mediaError},'image delivery failed; using text fallback')}}if(!sent){sent=await s.sock.sendMessage(jid,{text:j.message_text});deliveryMode=imageUrl?'text_fallback':'text'}";
const singleMedia = "if(!imageUrl)throw new Error('offer_image_required');try{const media=await fetchOfferImage(imageUrl);sent=await s.sock.sendMessage(jid,{image:media.buffer,caption:j.message_text,mimetype:'image/jpeg',jpegThumbnail:media.thumbnail});deliveryMode='image_caption_single';const mediaMid=sent?.key?.id||null;if(!mediaMid)throw new Error('whatsapp_missing_media_message_id');j.media_message_id=mediaMid;const mt=now();await db.from('whatsapp_outbound_jobs').update({media_message_id:mediaMid,media_sent_at:mt,delivery_mode:'image_caption_single',media_error:null,updated_at:mt}).eq('id',j.id);await db.from('audit_events').insert({user_id:j.user_id,event_type:'offer.media.accepted.whatsapp',entity_type:'offer',entity_id:j.offer_id,redacted_metadata:{job_id:j.id,group_ref_id:j.group_ref_id,media_message_id:mediaMid,delivery_mode:'image_caption_single'}})}catch(e){mediaError=String(e?.message||e).slice(0,220);const mt=now();await db.from('whatsapp_outbound_jobs').update({media_error:mediaError,delivery_mode:'image_caption_required',updated_at:mt}).eq('id',j.id);await db.from('audit_events').insert({user_id:j.user_id,event_type:'offer.media.failed.whatsapp',entity_type:'offer',entity_id:j.offer_id,redacted_metadata:{job_id:j.id,group_ref_id:j.group_ref_id,media_error:mediaError,delivery_mode:'image_caption_required'}}).catch(()=>{});throw new Error('image_delivery_failed:'+mediaError)}";
if (!src.includes(singleMedia)) {
  if (!src.includes(oldMedia)) throw new Error('media send signature changed; single-message patch aborted');
  src = src.replace(oldMedia, singleMedia);
}

const oldAccepted = "redacted_metadata:{job_id:j.id,group_ref_id:j.group_ref_id,message_id:mid,delivery_mode:deliveryMode,had_image:Boolean(imageUrl),media_error:mediaError}";
const newAccepted = "redacted_metadata:{job_id:j.id,group_ref_id:j.group_ref_id,message_id:mid,media_message_id:j.media_message_id||mid,delivery_mode:deliveryMode,had_image:true,media_error:mediaError}";
if (!src.includes(newAccepted) && src.includes(oldAccepted)) src = src.replace(oldAccepted, newAccepted);

src = src.replace("service:'afilia-whatsapp-worker-v6-media-ack'", "service:'afilia-whatsapp-worker-v8-single-media'");
src = src.replace("service:'afilia-whatsapp-worker-v6-ack'", "service:'afilia-whatsapp-worker-v8-single-media'");
src = src.replace("service:'afilia-whatsapp-worker-v7-strict-media'", "service:'afilia-whatsapp-worker-v8-single-media'");
src = src.replace("log.info('Afilia WhatsApp worker v6-ack started')", "log.info('Afilia WhatsApp worker v8-single-media started')");
src = src.replace("log.info('Afilia WhatsApp worker v5-media started')", "log.info('Afilia WhatsApp worker v8-single-media started')");
src = src.replace("log.info('Afilia WhatsApp worker v7-strict-media started')", "log.info('Afilia WhatsApp worker v8-single-media started')");

fs.writeFileSync(file, src);
console.log('[patch-media-strict] enforced one WhatsApp message: product image + rendered template caption; no split or text fallback');
