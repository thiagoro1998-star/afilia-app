import fs from 'node:fs';

const file = new URL('./worker-v5-media.js', import.meta.url);
let src = fs.readFileSync(file, 'utf8');

// Full history is needed when a QR-linked device is being born so groups/chats can be discovered.
// On normal Railway restarts/reconnects the session and groups are already persisted; replaying
// thousands of messages only increases memory/network pressure and can destabilize the socket.
const historyOld = "syncFullHistory:true,fireInitQueries:true,shouldSyncHistoryMessage:()=>true";
const historyNew = "syncFullHistory:Boolean(requestId),fireInitQueries:true,shouldSyncHistoryMessage:()=>Boolean(requestId)";
if (!src.includes(historyNew)) {
  if (!src.includes(historyOld)) throw new Error('socket history signature changed; light reconnect patch aborted');
  src = src.replace(historyOld, historyNew);
}

// Keep only a conservative number of normalized product images in RAM.
const cacheOld = "if(mediaCache.size>80)mediaCache.delete(mediaCache.keys().next().value)";
const cacheNew = "if(mediaCache.size>24)mediaCache.delete(mediaCache.keys().next().value)";
if (!src.includes(cacheNew)) {
  if (!src.includes(cacheOld)) throw new Error('media cache signature changed; light reconnect patch aborted');
  src = src.replace(cacheOld, cacheNew);
}

src = src.replace("service:'afilia-whatsapp-worker-v10-stable-media'", "service:'afilia-whatsapp-worker-v11-light-reconnect'");
src = src.replace("log.info('Afilia WhatsApp worker v10-stable-media started')", "log.info('Afilia WhatsApp worker v11-light-reconnect started')");

fs.writeFileSync(file, src);
console.log('[patch-reconnect-light] full history limited to initial pairing; media cache capped at 24 items');
