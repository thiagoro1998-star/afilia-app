import fs from 'node:fs/promises';

const file = new URL('./shopee-resolver.js', import.meta.url);
let src = await fs.readFile(file, 'utf8');
let changed = false;

const oldN = "function n(v){const x=Number(String(v??'').replace(',','.'));return Number.isFinite(x)?x:null}";
const newN = "function n(v){if(v===null||v===undefined||String(v).trim()==='')return null;const x=Number(String(v).replace(',','.'));return Number.isFinite(x)?x:null}";
if (src.includes(oldN)) {
  src = src.replace(oldN, newN);
  changed = true;
} else if (!src.includes(newN)) {
  throw new Error('Could not locate Shopee numeric parser');
}

const helperTag = 'async function publicProductFallback(';
const helperMarker = 'function fallbackPrevious(current,discountRate){';
if (!src.includes(helperTag)) {
  if (!src.includes(helperMarker)) throw new Error('Could not locate Shopee fallback insertion point');
  const helper = `function decodeEntities(s=''){return String(s).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')}
function cleanProductTitle(s=''){
  let x=decodeEntities(decodeLoose(s)).replace(/\\s+/g,' ').trim();
  x=x.replace(/\\s*\\|\\s*Shopee.*$/i,'').trim();
  if(!x||/^Shopee Brasil\\b/i.test(x)||/^Shopee\\b.*ofertas/i.test(x))return'';
  return x;
}
function publicProductImage(v=''){
  const s=decodeEntities(decodeLoose(v)).trim();
  if(!s||/homepagefe|shopee-mobilemall-live-sg\\/homepage/i.test(s))return null;
  if(/^https?:\\/\\//i.test(s))return s;
  return 'https://down-br.img.susercontent.com/file/'+s.replace(/^\\/+/, '');
}
async function publicProductFallback(shopId,itemId,canonical){
  let title='',imageUrl=null,price=null;
  if(shopId&&itemId){
    const endpoint='https://shopee.com.br/api/v4/item/get?itemid='+encodeURIComponent(itemId)+'&shopid='+encodeURIComponent(shopId);
    for(const ua of UAS){
      try{
        const r=await fetch(endpoint,{headers:{'user-agent':ua,'accept-language':'pt-BR,pt;q=0.9',accept:'application/json,text/plain,*/*',referer:canonical},signal:AbortSignal.timeout(12000)});
        if(r.ok){
          const j=await r.json(),d=j?.data?.item_basic||j?.data?.item||j?.data||{};
          title=cleanProductTitle(d?.name||d?.product_name||d?.title||'')||title;
          imageUrl=publicProductImage(d?.image||d?.images?.[0]||d?.image_url||'')||imageUrl;
          if(title&&imageUrl)break;
        }
      }catch{}
    }
  }
  for(const ua of UAS){
    try{
      const r=await fetch(canonical,{redirect:'follow',headers:{'user-agent':ua,'accept-language':'pt-BR,pt;q=0.9','cache-control':'no-cache'},signal:AbortSignal.timeout(12000)});
      const html=(await r.text()).slice(0,3_000_000);
      title=title||cleanProductTitle(meta(html,'og:title')||meta(html,'twitter:title'));
      imageUrl=imageUrl||publicProductImage(meta(html,'og:image')||meta(html,'twitter:image'));
      const rawPrice=meta(html,'product:price:amount')||meta(html,'og:price:amount');
      const parsed=n(rawPrice);if(Number.isFinite(parsed)&&parsed>0)price=parsed;
      if(title&&imageUrl&&price!==null)break;
    }catch{}
  }
  return{title,imageUrl,price};
}
`;
  src = src.replace(helperMarker, helper + helperMarker);
  changed = true;
}

const oldProductLine = '      const p=await product(job.user_id,r.shopId,r.itemId);';
const patchedProductTag = "      let p=null,apiError='';";
if (src.includes(oldProductLine)) {
  const replacement = `      let p=null,apiError='';
      try{p=await product(job.user_id,r.shopId,r.itemId)}catch(e){apiError=String(e?.message||e)}
      if(!p){
        const canonical=r.shopId?\`https://shopee.com.br/product/\${r.shopId}/\${r.itemId}\`:(r.resolvedUrl||job.source_url);
        const fb=await publicProductFallback(r.shopId,r.itemId,canonical);
        if(!fb.title&&!fb.imageUrl&&fb.price===null)throw new Error(apiError||'public_fallback_empty');
        await db.from('shopee_resolution_jobs').update({
          status:'done',resolved_url:r.resolvedUrl,shop_id:String(r.shopId||'')||null,item_id:String(r.itemId),
          product_title:fb.title||null,image_url:fb.imageUrl||null,product_url:canonical,offer_link:null,
          price_min:fb.price??null,price_max:fb.price??null,discount_rate:null,previous_price:null,previous_price_source:null,
          finished_at:now(),updated_at:now(),last_error:null
        }).eq('id',job.id);
        console.warn(JSON.stringify({event:'shopee_public_fallback',job:job.id,itemId:r.itemId,api_error:apiError.slice(0,180),title:!!fb.title,image:!!fb.imageUrl,price:fb.price}));
        continue;
      }`;
  src = src.replace(oldProductLine, replacement);
  changed = true;
} else if (!src.includes(patchedProductTag)) {
  throw new Error('Could not locate Shopee product lookup');
}

if (changed) {
  await fs.writeFile(file, src);
  console.log('[patch-shopee-public-fallback] applied');
} else {
  console.log('[patch-shopee-public-fallback] already applied');
}
