import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL='https://yjgwlofhordbmjomxcdx.supabase.co';
const SUPABASE_KEY='sb_publishable_qASwZXIwsbouYZpC-X0YWA_675aTqWN';
const supabase=createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const $=id=>document.getElementById(id);

function showStatus(text,ok=false){
  const s=$('status');
  if(!s)return;
  s.textContent=text;
  s.className='status show '+(ok?'ok':'err');
}

function message(err){
  const m=String(err?.message||err||'');
  if(/Invalid login credentials|invalid credentials/i.test(m))return'E-mail ou senha incorretos. Se não lembrar a senha, use “Esqueci minha senha”.';
  if(/Email not confirmed/i.test(m))return'Seu e-mail ainda não foi confirmado. Abra o e-mail do Afilia e toque no link de confirmação.';
  if(/rate limit|too many requests|429/i.test(m))return'Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.';
  if(/fetch|network|timeout|connection|Failed to fetch|Load failed/i.test(m))return'A conexão com o Afilia oscilou. Verifique a internet e tente novamente em alguns segundos.';
  return'Não foi possível entrar agora. Sua conta continua ativa. Tente novamente ou use “Esqueci minha senha”.';
}

function transient(err){
  return /fetch|network|timeout|connection|Failed to fetch|Load failed|502|503|504/i.test(String(err?.message||err||''));
}

async function signInWithRetry(email,password){
  let last;
  for(let i=0;i<3;i++){
    try{
      const {data,error}=await supabase.auth.signInWithPassword({email,password});
      if(error)throw error;
      if(!data?.session)throw new Error('session_not_created');
      return data;
    }catch(err){
      last=err;
      if(!transient(err)||i===2)throw err;
      await sleep(450*(i+1));
    }
  }
  throw last;
}

function install(){
  const go=$('go');
  if(!go||go.dataset.resilientLogin==='1')return;
  go.dataset.resilientLogin='1';
  const original=go.onclick;
  go.onclick=async event=>{
    const signup=$('signupTab')?.classList.contains('on');
    if(signup)return original?.call(go,event);
    const email=$('email')?.value.trim()||'';
    const password=$('password')?.value||'';
    if(!email||!password){showStatus('Preencha e-mail e senha.');return}
    if(typeof navigator!=='undefined'&&navigator.onLine===false){showStatus('Seu aparelho está sem conexão com a internet. Conecte-se e tente novamente.');return}
    go.disabled=true;
    go.textContent='Entrando…';
    try{
      await signInWithRetry(email,password);
      location.replace('./index.html');
    }catch(err){
      console.error('Afilia login failed',String(err?.message||err));
      showStatus(message(err));
      go.disabled=false;
      go.textContent='Entrar';
    }
  };
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
