import fs from 'node:fs';
const file=new URL('./worker-v5-media.js',import.meta.url);
let src=fs.readFileSync(file,'utf8');

// Reliability mode keeps ACK/anti-duplicate protections, but media delivery stays enabled.
const oldFlag="async function flagUnconfirmed(){const cutoff=new Date(Date.now()-90000).toISOString();const{data:rows=[]}=await db.from('whatsapp_outbound_jobs').select('id').eq('status','processing').eq('ack_status','accepted').lt('accepted_at',cutoff).is('last_error',null).limit(20);for(const r of rows)await db.from('whatsapp_outbound_jobs').update({last_error:'Aguardando confirmação do WhatsApp; não reenviado para evitar duplicidade.',updated_at:now()}).eq('id',r.id)}";
const newFlag="async function flagUnconfirmed(){const warnCutoff=new Date(Date.now()-90000).toISOString(),failCutoff=new Date(Date.now()-180000).toISOString();const{data:warn=[]}=await db.from('whatsapp_outbound_jobs').select('id').eq('status','processing').eq('ack_status','accepted').lt('accepted_at',warnCutoff).is('last_error',null).limit(20);for(const r of warn)await db.from('whatsapp_outbound_jobs').update({last_error:'Aguardando confirmação do WhatsApp; não reenviado para evitar duplicidade.',updated_at:now()}).eq('id',r.id);const{data:fail=[]}=await db.from('whatsapp_outbound_jobs').select('id,user_id,group_ref_id,confirmation_notified_at').eq('status','processing').eq('ack_status','accepted').lt('accepted_at',failCutoff).limit(20);for(const r of fail){const t=now();await db.from('whatsapp_outbound_jobs').update({status:'failed',ack_status:'unconfirmed',last_error:'WhatsApp não confirmou a entrega dentro de 3 minutos.',updated_at:t}).eq('id',r.id);if(!r.confirmation_notified_at){const{data:g}=await db.from('whatsapp_group_refs').select('display_name').eq('id',r.group_ref_id).maybeSingle();const ok=await notifyTelegram(r.user_id,'⚠️ O WhatsApp não confirmou a entrega para '+(g?.display_name||'o grupo')+'. O Afilia não reenviou automaticamente para evitar duplicidade.');if(ok)await db.from('whatsapp_outbound_jobs').update({confirmation_notified_at:t}).eq('id',r.id).is('confirmation_notified_at',null)}}}";
if(src.includes(oldFlag))src=src.replace(oldFlag,newFlag);
else if(!src.includes("ack_status:'unconfirmed'"))throw new Error('flagUnconfirmed signature changed');

src=src.replace("service:'afilia-whatsapp-worker-v6-ack'","service:'afilia-whatsapp-worker-v6-media-ack'");
fs.writeFileSync(file,src);
console.log('[patch-text-reliability] media delivery + ACK/anti-duplicate protections enabled');
