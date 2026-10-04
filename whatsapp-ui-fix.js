async function bootWhatsAppUi(){
  try{
    const old=document.getElementById('afiliaWhatsappCard');
    if(old) old.remove();
    await import('./whatsapp.js?v=052');
    if(typeof window.refreshWaCard==='function') await window.refreshWaCard();
  }catch(e){
    console.error('whatsapp-ui-fix',e);
  }
}
if(document.readyState==='loading'){
  window.addEventListener('DOMContentLoaded',()=>setTimeout(bootWhatsAppUi,300),{once:true});
}else{
  setTimeout(bootWhatsAppUi,300);
}
