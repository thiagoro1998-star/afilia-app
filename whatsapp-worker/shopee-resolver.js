import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const SUPABASE_URL=process.env.SUPABASE_URL, SERVICE_ROLE=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!SUPABASE_URL||!SERVICE_ROLE)throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db=createClient(SUPABASE_URL,SERVICE_ROLE,{auth:{persistSession:false,autoRefreshToken:false}});
const wait=ms=>new Promise(r=>setTimeout(r,ms)), now=()=>new Date().toISOString();
const UAS=[
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
];
const sha=s=>createHash('sha256').update(s).digest('hex');

function decodeLoose(s=''){
  let x=String(s).replace(/\\u002F/gi,'/').replace(/\\\//g,'/').replace(/&amp;/g,'&');
  try{x=decodeURIComponent(x)}catch{}
  return x;
}
function extractIdentity(raw=''){
  for(const s of [String(raw),decodeLoose(raw)]){
    let m=s.match(/(?:-i\.|\/i\.)(\d+)\.(\d+)/i)||s.match(/\/product\/(\d+)\/(\d+)/i)||s.match(/\/opaanlp\/(\d+)\/(\d+)/i);
    if(m)return{shopId:m[1],itemId:m[2]};
    const item=s.match(/[?&](?:itemId|itemid)=([0-9]+)/i)?.[1],shop=s.match(/[?&](?:shopId|shopid)=([0-9]+)/i)?.[1];
    if(item)return{shopId:shop||null,itemId:item};
  }
  return null;
}
function candidateUrls(html='',base=''){
  const out=[];
  const push=v=>{if(!v)return;v=decodeLoose(v).replace(/^['\"]|['\"]$/g,'');try{out.push(new URL(v,base).href)}catch{}};
  for(const m of html.matchAll(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"']+)/ig))push(m[1]);
  for(const m of html.matchAll(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/ig))push(m[1]);
  for(const m of html.matchAll(/location\.(?:replace|assign)\(\s*["']([^"']+)["']/ig))push(m[1]);
  for(const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+/ig))push(m[0]);
  for(const m of html.matchAll(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/ig))push(m[1]);
  for(const m of html.matchAll(/[?&](?:redirect|redirect_url|target|url|fallback_url|deep_link)=([^&"'<>]+)/ig))push(m[1]);
  return[...new Set(out)];
}
function useful(url=''){return /shopee\.com\.br\/(?:product\/|opaanlp\/|.*-i\.)/i.test(url)||/[?&](?:itemId|itemid)=\d+/i.test(url)}

async function resolveOnce(start,ua){
  let current=start;
  for(let hop=0;hop<12;hop++){
    const id=extractIdentity(current);if(id)return{resolvedUrl:current,...id,method:'url'};
    let r;
    try{r=await fetch(current,{redirect:'manual',headers:{'user-agent':ua,accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','accept-language':'pt-BR,pt;q=0.9,en;q=0.7','cache-control':'no-cache'},signal:AbortSignal.timeout(12000)})}
    catch(e){return{error:`fetch:${String(e?.message||e)}`}}
    const loc=r.headers.get('location');if(loc){current=new URL(loc,current).href;continue}
    let html='';try{html=(await r.text()).slice(0,2_000_000)}catch{}
    const cs=candidateUrls(html,current),direct=cs.find(u=>extractIdentity(u))||cs.find(useful);
    if(direct){current=direct;continue}
    if(r.url&&r.url!==current){current=r.url;continue}
    return{resolvedUrl:current,error:`no_identity_http_${r.status}`};
  }
  const id=extractIdentity(current);return id?{resolvedUrl:current,...id,method:'redirect'}:{resolvedUrl:current,error:'redirect_limit'};
}
async function resolveShopee(url){
  const direct=extractIdentity(url);if(direct)return{resolvedUrl:url,...direct,method:'direct'};
  let last={resolvedUrl:url,error:'unresolved'};
  for(const ua of UAS){
    const r=await resolveOnce(url,ua);last=r;if(r.itemId)return r;
    try{const f=await fetch(url,{redirect:'follow',headers:{'user-agent':ua,'accept-language':'pt-BR,pt;q=0.9'},signal:AbortSignal.timeout(12000)}),id=extractIdentity(f.url);if(id)return{resolvedUrl:f.url,...id,method:'follow'}}catch{}
  }
  return last;
}

async function creds(userId){
  const{data:mp,error:me}=await db.from('marketplaces').select('id').eq('slug','shopee').single();if(me)throw me;
  const{data:mi,error:ie}=await db.from('marketplace_integrations').select('metadata,credentials_configured').eq('user_id',userId).eq('marketplace_id',mp.id).maybeSingle();if(ie)throw ie;
  if(!mi?.credentials_configured)throw new Error('shopee_not_configured');
  const appId=String(mi.metadata?.app_id||'').trim();
  const{data:appSecret,error:se}=await db.rpc('service_get_marketplace_secret',{p_user_id:userId,p_marketplace_slug:'shopee',p_secret_key:'app_secret'});if(se)throw se;
  if(!appId||!appSecret)throw new Error('shopee_credentials_missing');
  return{appId,appSecret:String(appSecret)};
}
async function api(userId,query){
  const{appId,appSecret}=await creds(userId),payload=JSON.stringify({query}),timestamp=Math.floor(Date.now()/1000).toString(),signature=sha(appId+timestamp+payload+appSecret);
  const r=await fetch('https://open-api.affiliate.shopee.com.br/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:`SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`},body:payload,signal:AbortSignal.timeout(15000)}),j=await r.json();
  if(!r.ok||j?.errors?.length)throw new Error(j?.errors?.[0]?.message||`shopee_http_${r.status}`);
  return j?.data||{};
}
async function product(userId,shopId,itemId){
  const args=[shopId?`shopId: ${shopId}`:'',`itemId: ${itemId}`,'page: 1','limit: 1'].filter(Boolean).join(', ');
  const data=await api(userId,`{ productOfferV2(${args}) { nodes { itemId shopId productName productLink offerLink imageUrl priceMin priceMax priceDiscountRate } pageInfo { page limit hasNextPage } } }`);
  const p=data?.productOfferV2?.nodes?.[0];if(!p)throw new Error('product_not_in_offer_catalog');return p;
}

function n(v){const x=Number(String(v??'').replace(',','.'));return Number.isFinite(x)?x:null}
function meta(html,key){
  const k=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for(const re of [new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']+)["']`,'i'),new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${k}["']`,'i')]){const m=html.match(re);if(m)return m[1]}
  return'';
}
function choosePrevious(rawValues,current,discountRate){
  if(!Number.isFinite(current)||current<=0)return null;
  const estimate=discountRate>0&&discountRate<100?current/(1-discountRate/100):null;
  const candidates=[];
  for(const raw of rawValues){
    const base=n(raw);if(!Number.isFinite(base)||base<=0)continue;
    for(const div of [1,100,1000,100000]){
      const v=base/div;
      if(v>current*1.005&&v<current*30)candidates.push(v);
    }
  }
  if(!candidates.length)return null;
  if(estimate)return candidates.sort((a,b)=>Math.abs(a-estimate)-Math.abs(b-estimate))[0];
  return candidates.sort((a,b)=>a-b)[0];
}
function previousFromHtml(html,current,discountRate){
  if(!html)return null;
  const raws=[];
  const patterns=[
    /["']price_before_discount["']\s*:\s*["']?([0-9]+(?:[.,][0-9]+)?)/ig,
    /["']priceBeforeDiscount["']\s*:\s*["']?([0-9]+(?:[.,][0-9]+)?)/ig,
    /["']price_min_before_discount["']\s*:\s*["']?([0-9]+(?:[.,][0-9]+)?)/ig,
    /["']priceMaxBeforeDiscount["']\s*:\s*["']?([0-9]+(?:[.,][0-9]+)?)/ig,
    /["']original_price["']\s*:\s*["']?([0-9]+(?:[.,][0-9]+)?)/ig,
    /["']originalPrice["']\s*:\s*["']?([0-9]+(?:[.,][0-9]+)?)/ig
  ];
  for(const re of patterns)for(const m of html.matchAll(re))raws.push(m[1]);
  for(const key of ['product:original_price:amount','product:price:standard_amount','og:price:standard_amount']){const v=meta(html,key);if(v)raws.push(v)}
  const chosen=choosePrevious(raws,current,discountRate);
  return chosen?{value:chosen,source:'page_exact'}:null;
}
async function pageSignals(url,current,discountRate){
  let best={previous:null,image:null};
  for(const ua of UAS){
    try{
      const r=await fetch(url,{redirect:'follow',headers:{'user-agent':ua,'accept-language':'pt-BR,pt;q=0.9','cache-control':'no-cache'},signal:AbortSignal.timeout(12000)});
      const html=(await r.text()).slice(0,3_000_000);
      const previous=previousFromHtml(html,current,discountRate);
      const image=meta(html,'og:image')||meta(html,'twitter:image')||null;
      if(previous)return{previous,image};
      if(image&&!best.image)best.image=image;
    }catch{}
  }
  return best;
}
function fallbackPrevious(current,discountRate){
  if(Number.isFinite(current)&&discountRate>0&&discountRate<100){const v=current/(1-discountRate/100);if(v>current)return{value:v,source:'discount_estimate'}}
  return null;
}

async function tick(){
  const{data:jobs=[],error}=await db.from('shopee_resolution_jobs').select('*').eq('status','queued').order('created_at').limit(5);if(error)throw error;
  for(const job of jobs){
    const attempts=Number(job.attempts||0)+1;
    const{data:lock}=await db.from('shopee_resolution_jobs').update({status:'processing',started_at:now(),attempts,updated_at:now(),last_error:null}).eq('id',job.id).eq('status','queued').select('id').maybeSingle();if(!lock)continue;
    try{
      const r=await resolveShopee(job.source_url);if(!r.itemId)throw new Error(r.error||'shortlink_unresolved');
      const p=await product(job.user_id,r.shopId,r.itemId);
      const current=n(p.priceMin),rate=n(p.priceDiscountRate)||0;
      const canonical=p.productLink||`https://shopee.com.br/product/${p.shopId||r.shopId}/${p.itemId||r.itemId}`;
      const page=await pageSignals(canonical,current,rate);
      const previous=page.previous||fallbackPrevious(current,rate);
      const image=p.imageUrl||page.image||null;
      await db.from('shopee_resolution_jobs').update({
        status:'done',resolved_url:r.resolvedUrl,shop_id:String(p.shopId||r.shopId||'')||null,item_id:String(p.itemId||r.itemId),
        product_title:p.productName||null,image_url:image,product_url:canonical,offer_link:p.offerLink||null,
        price_min:p.priceMin??null,price_max:p.priceMax??null,discount_rate:p.priceDiscountRate??null,
        previous_price:previous?.value??null,previous_price_source:previous?.source??null,
        finished_at:now(),updated_at:now(),last_error:null
      }).eq('id',job.id);
      console.log(JSON.stringify({event:'shopee_enriched',job:job.id,itemId:r.itemId,method:r.method||null,image:!!image,previous_price:previous?.value??null,previous_source:previous?.source??null}));
    }catch(e){
      const msg=String(e?.message||e).slice(0,500);
      await db.from('shopee_resolution_jobs').update({status:attempts>=2?'failed':'queued',last_error:msg,updated_at:now(),finished_at:attempts>=2?now():null}).eq('id',job.id);
      console.error(JSON.stringify({event:'shopee_resolve_failed',job:job.id,error:msg}));
    }
  }
}
console.log('Afilia Shopee resolver + cover + previous price enrichment started');
for(;;){try{await tick()}catch(e){console.error('resolver loop',String(e))}await wait(1000)}
