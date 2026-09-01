window.AFILIA_WA_GATEWAY='railway-persistent';
const __afiliaOriginalPair=window.startWhatsAppPairing;
if(typeof __afiliaOriginalPair==='function'){
  window.startWhatsAppPairing=async(...args)=>{
    if(window.__afiliaPairLock)return;
    window.__afiliaPairLock=true;
    try{return await __afiliaOriginalPair(...args)}finally{setTimeout(()=>{window.__afiliaPairLock=false},4000)}
  };
}
