import fs from 'node:fs/promises';

const file=new URL('./shopee-resolver.js',import.meta.url);
let src=await fs.readFile(file,'utf8');
let changed=false;

const helperMarker="async function publicProductFallback(shopId,itemId,canonical){";
if(!src.includes('function normalizeShopeePublicPrice(')){
  if(!src.includes(helperMarker))throw new Error('public fallback helper not found');
  const helper=`function normalizeShopeePublicPrice(v){
  if(v===null||v===undefined||v==='')return null;
  if(typeof v==='object')v=v?.value??v?.amount??v?.price??v?.min_price??null;
  let x=Number(String(v??'').replace(',','.'));
  if(!Number.isFinite(x)||x<=0)return null;
  if(x>=10000)x=x/100000;
  return Number.isFinite(x)&&x>0?x:null;
}
`;
  src=src.replace(helperMarker,helper+helperMarker);
  changed=true;
}

const oldBlock=`          title=cleanProductTitle(d?.name||d?.product_name||d?.title||'')||title;
          imageUrl=publicProductImage(d?.image||d?.images?.[0]||d?.image_url||'')||imageUrl;
          if(title&&imageUrl)break;`;
const newBlock=`          title=cleanProductTitle(d?.name||d?.product_name||d?.title||'')||title;
          imageUrl=publicProductImage(d?.image||d?.images?.[0]||d?.image_url||'')||imageUrl;
          const publicPrice=normalizeShopeePublicPrice(d?.price_min??d?.price??d?.priceMin??d?.price_info?.current_price??d?.price_info?.price);
          if(Number.isFinite(publicPrice)&&publicPrice>0)price=publicPrice;
          if(title&&imageUrl&&price!==null)break;`;
if(src.includes(oldBlock)){
  src=src.replace(oldBlock,newBlock);
  changed=true;
}else if(!src.includes('const publicPrice=normalizeShopeePublicPrice(')){
  throw new Error('public fallback API block not found');
}

if(changed){await fs.writeFile(file,src);console.log('[patch-shopee-public-price] applied')}else console.log('[patch-shopee-public-price] already applied');
