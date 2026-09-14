import fs from 'node:fs/promises';

const file=new URL('./shopee-resolver.js',import.meta.url);
let src=await fs.readFile(file,'utf8');
let changed=false;

const marker='async function publicProductFallback(shopId,itemId,canonical){';
if(!src.includes('function shopeeSeoPriceFromHtml(')){
  if(!src.includes(marker))throw new Error('public fallback helper not found');
  const helper=`function shopeeSeoSlug(title=''){
  return String(title||'').normalize('NFKD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,180);
}
function shopeeSeoUrl(title,shopId,itemId){
  const slug=shopeeSeoSlug(title)||'produto';
  return 'https://shopee.com.br/'+encodeURIComponent(slug).replace(/%2D/g,'-')+'-i.'+encodeURIComponent(shopId)+'.'+encodeURIComponent(itemId);
}
function shopeeSeoPriceFromHtml(html,itemId=''){
  if(!html)return null;
  const source=String(html);
  const windows=[];
  const id=String(itemId||'');
  if(id){
    let at=source.indexOf(id),guard=0;
    while(at>=0&&guard<8){windows.push(source.slice(Math.max(0,at-18000),Math.min(source.length,at+30000)));at=source.indexOf(id,at+id.length);guard++}
  }
  windows.push(source.slice(0,3_000_000));
  const keys=['price_min','priceMin','price','current_price','currentPrice','price_min_before_discount','priceBeforeDiscount'];
  for(const text of windows){
    for(const key of keys){
      const re=new RegExp('[\\"\\\']'+key+'[\\"\\\']\\s*:\\s*[\\"\\\']?([0-9]+(?:[.,][0-9]+)?)','ig');
      for(const m of text.matchAll(re)){
        const v=normalizeShopeePublicPrice(m[1]);
        if(Number.isFinite(v)&&v>=1&&v<=200000)return v;
      }
    }
    const metas=[meta(text,'product:price:amount'),meta(text,'og:price:amount')];
    for(const raw of metas){const v=normalizeShopeePublicPrice(raw);if(Number.isFinite(v)&&v>=1&&v<=200000)return v}
  }
  return null;
}
async function shopeeSeoPrice(title,shopId,itemId){
  if(!title||!shopId||!itemId)return null;
  const urls=[
    shopeeSeoUrl(title,shopId,itemId),
    'https://shopee.com.br/search?keyword='+encodeURIComponent(title)
  ];
  for(const url of urls){
    for(const ua of UAS){
      try{
        const r=await fetch(url,{redirect:'follow',headers:{'user-agent':ua,'accept-language':'pt-BR,pt;q=0.9','cache-control':'no-cache',accept:'text/html,application/xhtml+xml'},signal:AbortSignal.timeout(15000)});
        if(!r.ok)continue;
        const html=(await r.text()).slice(0,3_000_000);
        const v=shopeeSeoPriceFromHtml(html,itemId);
        if(Number.isFinite(v)&&v>0)return v;
      }catch{}
    }
  }
  return null;
}
`;
  src=src.replace(marker,helper+marker);
  changed=true;
}

const oldReturn='  return{title,imageUrl,price};\n}';
const newReturn=`  if(price===null&&title&&shopId&&itemId){
    const seoPrice=await shopeeSeoPrice(title,shopId,itemId);
    if(Number.isFinite(seoPrice)&&seoPrice>0)price=seoPrice;
  }
  return{title,imageUrl,price};
}`;
if(src.includes(oldReturn)){
  src=src.replace(oldReturn,newReturn);
  changed=true;
}else if(!src.includes('const seoPrice=await shopeeSeoPrice(')){
  throw new Error('public fallback return not found');
}

if(changed){await fs.writeFile(file,src);console.log('[patch-shopee-seo-price] applied')}else console.log('[patch-shopee-seo-price] already applied');
