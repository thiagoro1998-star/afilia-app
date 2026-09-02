import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
const wait = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
];

function decodeLoose(s='') {
  let x = String(s).replace(/\\u002F/gi,'/').replace(/\\\//g,'/').replace(/&amp;/g,'&');
  try { x = decodeURIComponent(x); } catch {}
  return x;
}
function extractIdentity(raw='') {
  const candidates=[String(raw),decodeLoose(raw)];
  for(const s of candidates){
    let m=s.match(/(?:-i\.|\/i\.)(\d+)\.(\d+)/i)||s.match(/\/product\/(\d+)\/(\d+)/i)||s.match(/\/opaanlp\/(\d+)\/(\d+)/i);
    if(m)return{shopId:m[1],itemId:m[2]};
    const item=s.match(/[?&](?:itemId|itemid)=([0-9]+)/i)?.[1];
    const shop=s.match(/[?&](?:shopId|shopid)=([0-9]+)/i)?.[1];
    if(item)return{shopId:shop||null,itemId:item};
  }
  return null;
}
function candidateUrls(html='', base='') {
  const out=[];
  const push=v=>{ if(!v)return; v=decodeLoose(v).replace(/^['\"]|['\"]$/g,''); try{ out.push(new URL(v,base).href) }catch{} };
  for(const m of html.matchAll(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"']+)/ig)) push(m[1]);
  for(const m of html.matchAll(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/ig)) push(m[1]);
  for(const m of html.matchAll(/location\.(?:replace|assign)\(\s*["']([^"']+)["']/ig)) push(m[1]);
  for(const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+/ig)) push(m[0]);
  for(const m of html.matchAll(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/ig)) push(m[1]);
  for(const m of html.matchAll(/[?&](?:redirect|redirect_url|target|url|fallback_url|deep_link)=([^&"'<>]+)/ig)) push(m[1]);
  return [...new Set(out)];
}
function useful(url='') { return /shopee\.com\.br\/(?:product\/|opaanlp\/|.*-i\.)/i.test(url) || /[?&](?:itemId|itemid)=\d+/i.test(url); }

async function resolveOnce(start, ua) {
  let current=start;
  for(let hop=0;hop<12;hop++){
    const id=extractIdentity(current); if(id)return{resolvedUrl:current,...id,method:'url'};
    let r;
    try{
      r=await fetch(current,{redirect:'manual',headers:{'user-agent':ua,'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','accept-language':'pt-BR,pt;q=0.9,en;q=0.7','cache-control':'no-cache'},signal:AbortSignal.timeout(12000)});
    }catch(e){return{error:`fetch:${String(e?.message||e)}`}}
    const loc=r.headers.get('location');
    if(loc){current=new URL(loc,current).href;continue}
    let html='';
    try{html=(await r.text()).slice(0,2_000_000)}catch{}
    const candidates=candidateUrls(html,current);
    const direct=candidates.find(u=>extractIdentity(u))||candidates.find(useful);
    if(direct){current=direct;continue}
    if(r.url&&r.url!==current){current=r.url;continue}
    return{resolvedUrl:current,error:`no_identity_http_${r.status}`};
  }
  const id=extractIdentity(current);return id?{resolvedUrl:current,...id,method:'redirect'}:{resolvedUrl:current,error:'redirect_limit'};
}
async function resolveShopee(url){
  const direct=extractIdentity(url); if(direct)return{resolvedUrl:url,...direct,method:'direct'};
  let last={resolvedUrl:url,error:'unresolved'};
  for(const ua of UAS){
    const r=await resolveOnce(url,ua); last=r;
    if(r.itemId)return r;
    try{
      const f=await fetch(url,{redirect:'follow',headers:{'user-agent':ua,'accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(12000)});
      const id=extractIdentity(f.url); if(id)return{resolvedUrl:f.url,...id,method:'follow'};
    }catch{}
  }
  return last;
}
async function tick(){
  const {data:jobs=[],error}=await db.from('shopee_resolution_jobs').select('*').eq('status','queued').order('created_at').limit(5);
  if(error)throw error;
  for(const job of jobs){
    const attempts=Number(job.attempts||0)+1;
    const {data:lock}=await db.from('shopee_resolution_jobs').update({status:'processing',started_at:now(),attempts,updated_at:now(),last_error:null}).eq('id',job.id).eq('status','queued').select('id').maybeSingle();
    if(!lock)continue;
    try{
      const r=await resolveShopee(job.source_url);
      if(!r.itemId)throw new Error(r.error||'shortlink_unresolved');
      await db.from('shopee_resolution_jobs').update({status:'done',resolved_url:r.resolvedUrl,shop_id:r.shopId||null,item_id:r.itemId,finished_at:now(),updated_at:now(),last_error:null}).eq('id',job.id);
      console.log(JSON.stringify({event:'shopee_resolved',job:job.id,itemId:r.itemId,shopId:r.shopId||null,method:r.method||null}));
    }catch(e){
      const msg=String(e?.message||e).slice(0,500);
      await db.from('shopee_resolution_jobs').update({status:attempts>=2?'failed':'queued',last_error:msg,updated_at:now(),finished_at:attempts>=2?now():null}).eq('id',job.id);
      console.error(JSON.stringify({event:'shopee_resolve_failed',job:job.id,error:msg}));
    }
  }
}
console.log('Afilia Shopee resolver started');
for(;;){try{await tick()}catch(e){console.error('resolver loop',String(e))}await wait(1000)}
