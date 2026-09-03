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

const oldAudit = "redacted_metadata:{group_ref_id:j.group_ref_id,message_id:sent?.key?.id||null,delivery_mode:deliveryMode,had_image:Boolean(imageUrl),media_error:mediaError}";
const newAudit = "redacted_metadata:{group_ref_id:j.group_ref_id,message_id:sent?.key?.id||null,delivery_mode:deliveryMode,had_image:Boolean(imageUrl),media_error:mediaError}";
// Keep audit schema stable; delivery_mode now distinguishes normalized JPEG.
if (!src.includes(oldAudit)) console.warn('audit signature differs; continuing without audit patch');

fs.writeFileSync(file, src);
console.log('[patch-worker] WhatsApp image pipeline normalized to JPEG');
