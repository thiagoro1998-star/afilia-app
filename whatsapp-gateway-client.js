window.AFILIA_WA_GATEWAY='railway-persistent';

const __afiliaOriginalPair=window.startWhatsAppPairing;
if(typeof __afiliaOriginalPair==='function'){
  window.startWhatsAppPairing=async(...args)=>{
    if(window.__afiliaPairLock)return;
    window.__afiliaPairLock=true;
    try{return await __afiliaOriginalPair(...args)}finally{setTimeout(()=>{window.__afiliaPairLock=false},4000)}
  };
}

// Persist group activation rigorously. The UI only re-renders after Supabase
// confirms that the requested state was actually written for the logged user.
window.toggleWhatsGroup=async(id,on)=>{
  const supabase=window.afiliaSupabase;
  if(!supabase){alert('A conexão com o Afilia ainda não está pronta. Atualize a página e tente novamente.');return;}
  try{
    const {data:{session},error:sessionError}=await supabase.auth.getSession();
    if(sessionError||!session?.user?.id)throw new Error('Sessão do Afilia não encontrada.');
    const userId=session.user.id;
    const {data,error}=await supabase
      .from('whatsapp_group_refs')
      .update({is_enabled:!!on,updated_at:new Date().toISOString()})
      .eq('id',id)
      .eq('user_id',userId)
      .select('id,display_name,is_enabled')
      .maybeSingle();
    if(error)throw error;
    if(!data)throw new Error('O grupo não pertence à conexão atual. Reabra a integração.');
    if(Boolean(data.is_enabled)!==Boolean(on))throw new Error('O Supabase não confirmou a alteração.');
    if(typeof window.openWhatsAppManager==='function')await window.openWhatsAppManager();
    if(typeof window.refreshWaCard==='function')await window.refreshWaCard();
  }catch(err){
    console.error('toggleWhatsGroup failed',err);
    alert(`Não foi possível ${on?'ativar':'desativar'} este grupo. ${err?.message||'Tente novamente.'}`);
    if(typeof window.openWhatsAppManager==='function')await window.openWhatsAppManager();
  }
};
