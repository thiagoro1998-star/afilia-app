import fs from 'node:fs';

const file = new URL('./worker-v5-media.js', import.meta.url);
let src = fs.readFileSync(file, 'utf8');

const old = "await db.from('whatsapp_outbound_jobs').update({status:attempts>=3?'failed':'queued',ack_status:'error',last_error:msg,updated_at:now()}).eq('id',j.id)";
const replacement = "const finalStatus=attempts>=3?'failed':'queued';await db.from('whatsapp_outbound_jobs').update({status:finalStatus,ack_status:'error',last_error:msg,updated_at:now()}).eq('id',j.id);if(finalStatus==='failed'){const groupName=j.whatsapp_group_refs?.display_name||'o grupo';await notifyTelegram(j.user_id,'⚠️ Não consegui enviar a foto da oferta para '+groupName+' após 3 tentativas. O Afilia não enviou somente o texto para evitar uma publicação incompleta.').catch(()=>{})}";

if (!src.includes(replacement)) {
  if (!src.includes(old)) throw new Error('media final failure signature changed; feedback patch aborted');
  src = src.replace(old, replacement);
}

src = src.replace("service:'afilia-whatsapp-worker-v11-light-reconnect'", "service:'afilia-whatsapp-worker-v12-media-feedback'");
src = src.replace("log.info('Afilia WhatsApp worker v11-light-reconnect started')", "log.info('Afilia WhatsApp worker v12-media-feedback started')");

fs.writeFileSync(file, src);
console.log('[patch-media-user-feedback] final media failures notify Telegram without text-only fallback');
