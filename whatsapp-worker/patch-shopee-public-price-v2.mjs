import fs from 'node:fs/promises';

const file=new URL('./shopee-resolver.js',import.meta.url);
let src=await fs.readFile(file,'utf8');
let changed=false;

const helperMarker='async function publicProductFallback(shopId,itemId,canonical){';
if(!src.includes('async function publicProductPriceV2(')){
  if(!src.includes(helperMarker))throw new Error('public fallback helper not found');
  const helper=`function publicProductNode(j){
  const candidates=[
    j?.data?.item,
    j?.data?.item_basic,
    j?.data?.items_response?.items?.[0]?.item_basic,
    j?.data?.items_response?.items?.[0]?.item,
    j?.data?.items?.[0]?.item_basic,
    j?.data?.items?.[0],
    j?.data
  ];
  return candidates.find(x=>x&&typeof x==='object')||{};
}
function publicProductFields(j){
  const d=publicProductNode(j);
  const price=normalizeShopeePublicPrice(d?.price_min??d?.price??d?.priceMin??d?.price_info?.current_price??d?.price_info?.price??d?.models?.[0]?.price);
  const previous=normalizeShopeePublicPrice(d?.price_min_before_discount??d?.price_before_discount??d?.priceBeforeDiscount??d?.price_info?.original_price??d?.models?.[0]?.price_before_discount);
  const title=cleanProductTitle(d?.name||d?.product_name||d?.title||'');
  const imageUrl=publicProductImage(d?.image||d?.images?.[0]||d?.image_url||d?.imageUrl||'');
  return{title,imageUrl,price,previous};
}
async function publicProductPriceV2(shopId,itemId,canonical){
  if(!shopId||!itemId)return{title:'',imageUrl:null,price:null,previous:null};
  const headers={'user-agent':UAS[0],'accept-language':'pt-BR,pt;q=0.9,en;q=0.7',accept:'application/json,text/plain,*/*',referer:canonical,'x-api-source':'pc'};
  const attempts=[
    async()=>fetch('https://shopee.com.br/api/v4/item/get?itemid='+encodeURIComponent(itemId)+'&shopid='+encodeURIComponent(shopId),{headers,signal:AbortSignal.timeout(12000)}),
    async()=>fetch('https://shopee.com.br/api/v4/item/get_list',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({bff_meta:null,shop_item_ids:[{item_id:Number(itemId),shop_id:Number(shopId)}],source:'microsite_individual_product'}),signal:AbortSignal.timeout(12000)}),
    async()=>fetch('https://shopee.com.br/api/v4/pdp/get_pc?item_id='+encodeURIComponent(itemId)+'&shop_id='+encodeURIComponent(shopId),{headers,signal:AbortSignal.timeout(12000)})
  ];
  let best={title:'',imageUrl:null,price:null,previous:null};
  for(const make of attempts){
    try{
      const r=await make();
      if(!r.ok)continue;
      const f=publicProductFields(await r.json());
      if(!best.title&&f.title)best.title=f.title;
      if(!best.imageUrl&&f.imageUrl)best.imageUrl=f.imageUrl;
      if(best.price===null&&Number.isFinite(f.price)&&f.price>0)best.price=f.price;
      if(best.previous===null&&Number.isFinite(f.previous)&&f.previous>0)best.previous=f.previous;
      if(best.price!==null)break;
    }catch{}
  }
  if(best.price===null&&best.title){
    try{
      const u='https://shopee.com.br/api/v4/search/search_items?by=relevancy&keyword='+encodeURIComponent(best.title.slice(0,120))+'&limit=50&newest=0&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2';
      const r=await fetch(u,{headers:{...headers,referer:'https://shopee.com.br/'},signal:AbortSignal.timeout(12000)});
      if(r.ok){
        const j=await r.json(),items=j?.items||j?.data?.items||[];
        const hit=items.map(x=>x?.item_basic||x).find(x=>String(x?.itemid??x?.item_id??'')===String(itemId));
        if(hit){
          const p=normalizeShopeePublicPrice(hit?.price_min??hit?.price??hit?.priceMin);
          const prev=normalizeShopeePublicPrice(hit?.price_min_before_discount??hit?.price_before_discount);
          if(Number.isFinite(p)&&p>0)best.price=p;
          if(Number.isFinite(prev)&&prev>0)best.previous=prev;
          if(!best.imageUrl)best.imageUrl=publicProductImage(hit?.image||hit?.images?.[0]||'');
        }
      }
    }catch{}
  }
  return best;
}
`;
  src=src.replace(helperMarker,helper+helperMarker);
  changed=true;
}

const injectMarker=`  for(const ua of UAS){\n    try{\n      const r=await fetch(canonical,{redirect:'follow',headers:{'user-agent':ua,'accept-language':'pt-BR,pt;q=0.9','cache-control':'no-cache'},signal:AbortSignal.timeout(12000)});`;
if(!src.includes("const publicV2=await publicProductPriceV2(")){
  if(!src.includes(injectMarker))throw new Error('public fallback page loop not found');
  const inject=`  if(price===null){\n    const publicV2=await publicProductPriceV2(shopId,itemId,canonical);\n    title=title||publicV2.title;\n    imageUrl=imageUrl||publicV2.imageUrl;\n    if(Number.isFinite(publicV2.price)&&publicV2.price>0)price=publicV2.price;\n  }\n`;
  src=src.replace(injectMarker,inject+injectMarker);
  changed=true;
}

if(changed){await fs.writeFile(file,src);console.log('[patch-shopee-public-price-v2] applied')}else console.log('[patch-shopee-public-price-v2] already applied');
