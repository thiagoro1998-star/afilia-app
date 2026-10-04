const SUPABASE_URL='https://yjgwlofhordbmjomxcdx.supabase.co';
const BRIDGE_URL=`${SUPABASE_URL}/functions/v1/browser-bridge`;
const DEVICE_NAME='Chrome Afilia ML';

async function storageGet(keys){return await chrome.storage.local.get(keys)}
async function storageSet(value){return await chrome.storage.local.set(value)}
async function bridge(token,payload){
  const r=await fetch(BRIDGE_URL,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},body:JSON.stringify(payload)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j?.error||`bridge_http_${r.status}`);
  return j;
}
async function heartbeat(){
  const{afiliaAccessToken}=await storageGet(['afiliaAccessToken']);
  if(!afiliaAccessToken)return;
  try{await bridge(afiliaAccessToken,{op:'heartbeat',marketplace_slug:'mercado-livre',device_name:DEVICE_NAME});await storageSet({bridgeState:'online',bridgeLastError:null,bridgeLastSeen:Date.now()})}
  catch(e){await storageSet({bridgeState:'error',bridgeLastError:String(e?.message||e),bridgeLastSeen:Date.now()})}
}
async function getMlTab(){
  const tabs=await chrome.tabs.query({url:['https://www.mercadolivre.com.br/*','https://mercadolivre.com.br/*']});
  return tabs.find(t=>t.id)||null;
}
async function nextJob(){
  const{afiliaAccessToken}=await storageGet(['afiliaAccessToken']);
  if(!afiliaAccessToken)return;
  const tab=await getMlTab();
  if(!tab?.id){await storageSet({bridgeState:'waiting_ml_tab'});return}
  let j;
  try{j=await bridge(afiliaAccessToken,{op:'next_job',marketplace_slug:'mercado-livre',device_name:DEVICE_NAME})}catch(e){await storageSet({bridgeState:'error',bridgeLastError:String(e?.message||e)});return}
  if(!j?.job)return;
  try{
    const result=await chrome.tabs.sendMessage(tab.id,{type:'AFILIA_PROCESS_ML_JOB',job:j.job});
    if(!result?.ok)throw new Error(result?.error||'ml_job_failed');
    await bridge(afiliaAccessToken,{op:'complete_job',marketplace_slug:'mercado-livre',device_name:DEVICE_NAME,job_id:j.job.id,result:result.result});
    await storageSet({bridgeState:'online',bridgeLastError:null,lastCompletedJob:j.job.id});
  }catch(e){
    try{await bridge(afiliaAccessToken,{op:'fail_job',marketplace_slug:'mercado-livre',device_name:DEVICE_NAME,job_id:j.job.id,error:String(e?.message||e)})}catch{}
    await storageSet({bridgeState:'error',bridgeLastError:String(e?.message||e)});
  }
}
async function tick(){await heartbeat();await nextJob()}
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create('afiliaBridgeTick',{periodInMinutes:1});tick()});
chrome.runtime.onStartup.addListener(()=>{chrome.alarms.create('afiliaBridgeTick',{periodInMinutes:1});tick()});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='afiliaBridgeTick')tick()});
chrome.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{
  if(msg?.type==='AFILIA_BRIDGE_TICK'){tick().then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:String(e)}));return true}
});
