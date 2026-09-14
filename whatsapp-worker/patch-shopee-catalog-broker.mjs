import fs from 'node:fs/promises';

const file=new URL('./shopee-resolver.js',import.meta.url);
let src=await fs.readFile(file,'utf8');
let changed=false;

const insertMarker='function n(v){';
if(!src.includes('async function platformCatalogProduct(')){
  if(!src.includes(insertMarker))throw new Error('catalog insertion point not found');
  const helper=`async function platformCatalogProduct(requestUserId,shopId,itemId){
  const{data:mp,error:me}=await db.from('marketplaces').select('id').eq('slug','shopee').single();
  if(me||!mp?.id)return null;
  const{data:rows=[],error}=await db.from('marketplace_integrations')
    .select('user_id,status,credentials_configured,metadata,last_verified_at,updated_at')
    .eq('marketplace_id',mp.id)
    .eq('credentials_configured',true)
    .neq('user_id',requestUserId)
    .order('last_verified_at',{ascending:false,nullsFirst:false})
    .order('updated_at',{ascending:false})
    .limit(8);
  if(error)return null;
  const candidates=rows.filter(x=>String(x?.metadata?.api_error_code||'')!=='10035');
  for(const candidate of candidates){
    try{
      const p=await product(candidate.user_id,shopId,itemId);
      if(p?.productName){
        return{...p,offerLink:null,__catalogFallback:true};
      }
    }catch{}
  }
  return null;
}
`;
  src=src.replace(insertMarker,helper+insertMarker);
  changed=true;
}

const oldBlock=`      let p=null,apiError='';
      try{p=await product(job.user_id,r.shopId,r.itemId)}catch(e){apiError=String(e?.message||e)}
      if(!p){
        const canonical=r.shopId?\`https://shopee.com.br/product/\${r.shopId}/\${r.itemId}\`:(r.resolvedUrl||job.source_url);`;
const newBlock=`      let p=null,apiError='';
      try{p=await product(job.user_id,r.shopId,r.itemId)}catch(e){apiError=String(e?.message||e)}
      if(!p){
        try{
          const catalog=await platformCatalogProduct(job.user_id,r.shopId,r.itemId);
          if(catalog){p=catalog;console.warn(JSON.stringify({event:'shopee_catalog_fallback',job:job.id,itemId:r.itemId,user_api_error:apiError.slice(0,120)}))}
        }catch{}
      }
      if(!p){
        const canonical=r.shopId?\`https://shopee.com.br/product/\${r.shopId}/\${r.itemId}\`:(r.resolvedUrl||job.source_url);`;
if(src.includes(oldBlock)){
  src=src.replace(oldBlock,newBlock);
  changed=true;
}else if(!src.includes("event:'shopee_catalog_fallback'")){
  throw new Error('catalog fallback worker block not found');
}

if(changed){await fs.writeFile(file,src);console.log('[patch-shopee-catalog-broker] applied')}else console.log('[patch-shopee-catalog-broker] already applied');
