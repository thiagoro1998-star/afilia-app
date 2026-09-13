import fs from 'node:fs/promises';

const file = new URL('./shopee-resolver.js', import.meta.url);
let src = await fs.readFile(file, 'utf8');
let changed = false;

const helperTag = 'async function markShopeeIntegrationStatus(';
const helperMarker = 'async function api(userId,query){';
if (!src.includes(helperTag)) {
  if (!src.includes(helperMarker)) throw new Error('Could not locate Shopee api function');
  const helper = `async function markShopeeIntegrationStatus(userId,status,errorMessage=''){
  try{
    const{data:mp}=await db.from('marketplaces').select('id').eq('slug','shopee').maybeSingle();if(!mp?.id)return;
    const{data:mi}=await db.from('marketplace_integrations').select('id,metadata').eq('user_id',userId).eq('marketplace_id',mp.id).maybeSingle();if(!mi?.id)return;
    const at=now(),is10035=/10035/.test(errorMessage);
    const metadata={...(mi.metadata||{}),api_checked_at:at,api_error_code:errorMessage?(is10035?'10035':'api_error'):null,api_error_message:errorMessage?String(errorMessage).slice(0,300):null};
    await db.from('marketplace_integrations').update({status,last_verified_at:status==='connected'?at:null,metadata,updated_at:at}).eq('id',mi.id).eq('user_id',userId);
  }catch{}
}
`;
  src = src.replace(helperMarker, helper + helperMarker);
  changed = true;
}

const oldApi = "async function api(userId,query){\n  const{appId,appSecret}=await creds(userId),payload=JSON.stringify({query}),timestamp=Math.floor(Date.now()/1000).toString(),signature=sha(appId+timestamp+payload+appSecret);\n  const r=await fetch('https://open-api.affiliate.shopee.com.br/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:`SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`},body:payload,signal:AbortSignal.timeout(15000)}),j=await r.json();\n  if(!r.ok||j?.errors?.length)throw new Error(j?.errors?.[0]?.message||`shopee_http_${r.status}`);\n  return j?.data||{};\n}";
const newApi = "async function api(userId,query){\n  const{appId,appSecret}=await creds(userId),payload=JSON.stringify({query}),timestamp=Math.floor(Date.now()/1000).toString(),signature=sha(appId+timestamp+payload+appSecret);\n  const r=await fetch('https://open-api.affiliate.shopee.com.br/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:`SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`},body:payload,signal:AbortSignal.timeout(15000)}),j=await r.json();\n  if(!r.ok||j?.errors?.length){const msg=j?.errors?.[0]?.message||`shopee_http_${r.status}`;await markShopeeIntegrationStatus(userId,'error',msg);throw new Error(msg)}\n  await markShopeeIntegrationStatus(userId,'connected','');\n  return j?.data||{};\n}";
if (src.includes(oldApi)) {
  src = src.replace(oldApi, newApi);
  changed = true;
} else if (!src.includes(newApi)) {
  throw new Error('Could not patch Shopee api function');
}

if (changed) {
  await fs.writeFile(file, src);
  console.log('[patch-shopee-integration-status] applied');
} else {
  console.log('[patch-shopee-integration-status] already applied');
}
