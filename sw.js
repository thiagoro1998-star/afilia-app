const CACHE='afilia-v9';
const CORE=['./','./index.html','./auth.html','./app.js','./manifest.json','./icon.svg'];
self.addEventListener('install',event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)).catch(()=>{}));
});
self.addEventListener('activate',event=>{
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  ]));
});

async function enhanceHtml(req){
  const resp=await fetch(req,{cache:'no-store'});
  let html=await resp.text();
  html=html.replace('content="width=device-width,initial-scale=1,viewport-fit=cover"','content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"');
  if(!html.includes('app.js?v=031')) html=html.replace('</body>','<script type="module" src="./app.js?v=031"></script></body>');
  return new Response(html,{status:resp.status,statusText:resp.statusText,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
}

self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(req.mode==='navigate'){
    const isIndex=url.pathname.endsWith('/')||url.pathname.endsWith('/index.html');
    if(isIndex){
      event.respondWith(enhanceHtml(req).catch(()=>fetch('./auth.html',{cache:'no-store'})));
      return;
    }
    event.respondWith(fetch(req,{cache:'no-store'}).catch(()=>caches.match(req)));
    return;
  }
  event.respondWith(fetch(req,{cache:'no-store'}).then(resp=>{
    const copy=resp.clone();
    caches.open(CACHE).then(cache=>cache.put(req,copy)).catch(()=>{});
    return resp;
  }).catch(()=>caches.match(req)));
});