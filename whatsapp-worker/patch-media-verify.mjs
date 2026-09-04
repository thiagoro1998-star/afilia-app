import fs from 'node:fs';

const file = new URL('./worker-v5-media.js', import.meta.url);
let src = fs.readFileSync(file, 'utf8');

const old = "if(!imageUrl)throw new Error('offer_image_required');try{const media=await fetchOfferImage(imageUrl);sent=await s.sock.sendMessage(jid,{image:media.buffer,caption:j.message_text,mimetype:'image/jpeg',jpegThumbnail:media.thumbnail});deliveryMode='image_caption_single';const mediaMid=sent?.key?.id||null;if(!mediaMid)throw new Error('whatsapp_missing_media_message_id');j.media_message_id=mediaMid;const mt=now();await db.from('whatsapp_outbound_jobs').update({media_message_id:mediaMid,media_sent_at:mt,delivery_mode:'image_caption_single',media_error:null,updated_at:mt}).eq('id',j.id);await db.from('audit_events').insert({user_id:j.user_id,event_type:'offer.media.accepted.whatsapp',entity_type:'offer',entity_id:j.offer_id,redacted_metadata:{job_id:j.id,group_ref_id:j.group_ref_id,media_message_id:mediaMid,delivery_mode:'image_caption_single'}})}";

const replacement = "if(!imageUrl)throw new Error('offer_image_required');try{const media=await fetchOfferImage(imageUrl);if(!media?.buffer||!Buffer.isBuffer(media.buffer)||media.buffer.length<1024)throw new Error('invalid_offer_image_buffer');if(media.buffer[0]!==0xff||media.buffer[1]!==0xd8)throw new Error('offer_image_not_jpeg');sent=await s.sock.sendMessage(jid,{image:media.buffer,caption:j.message_text});const imageNode=sent?.message?.imageMessage||sent?.message?.viewOnceMessage?.message?.imageMessage||sent?.message?.viewOnceMessageV2?.message?.imageMessage;if(!imageNode)throw new Error('whatsapp_returned_non_image_message');deliveryMode='image_caption_verified';const mediaMid=sent?.key?.id||null;if(!mediaMid)throw new Error('whatsapp_missing_media_message_id');j.media_message_id=mediaMid;const mt=now();await db.from('whatsapp_outbound_jobs').update({media_message_id:mediaMid,media_sent_at:mt,delivery_mode:'image_caption_verified',media_error:null,updated_at:mt}).eq('id',j.id);await db.from('audit_events').insert({user_id:j.user_id,event_type:'offer.media.accepted.whatsapp',entity_type:'offer',entity_id:j.offer_id,redacted_metadata:{job_id:j.id,group_ref_id:j.group_ref_id,media_message_id:mediaMid,delivery_mode:'image_caption_verified',image_message_verified:true,image_bytes:media.buffer.length}})}";

if (!src.includes(replacement)) {
  if (!src.includes(old)) throw new Error('strict media block not found; media verification patch aborted');
  src = src.replace(old, replacement);
}

src = src.replace("service:'afilia-whatsapp-worker-v8-single-media'", "service:'afilia-whatsapp-worker-v9-verified-image'");
src = src.replace("log.info('Afilia WhatsApp worker v8-single-media started')", "log.info('Afilia WhatsApp worker v9-verified-image started')");

fs.writeFileSync(file, src);
console.log('[patch-media-verify] media success now requires a real Baileys imageMessage');
