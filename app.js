const AFILIA_VERSION='0.3.1';
const SUPABASE_URL='https://yjgwlofhordbmjomxcdx.supabase.co';
const SUPABASE_KEY='sb_publishable_qASwZXIwsbouYZpC-X0YWA_675aTqWN';

const {createClient}=await import('https://esm.sh/@supabase/supabase-js@2');
const supabase=createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
window.afiliaSupabase=supabase;

function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function requireSession(){
  const {data:{session}}=await supabase.auth.getSession();
  if(!session){
    location.replace('./auth.html');
    return null;
  }
  return session;
}

async function openProfile(){
  const {data:{user}}=await supabase.auth.getUser();
  if(!user){location.replace('./auth.html');return}
  const email=user.email||'Conta Afilia';
  const name=user.user_metadata?.name||'';
  if(typeof window.openModal==='function'){
    window.openModal(`<h3>Minha conta</h3><p>${esc(name||email)}</p><div class="notice good"><strong>Conta ativa</strong><br>${esc(email)}</div><div class="notice"><strong>Afilia ${AFILIA_VERSION}</strong><br>Sua sessão está protegida e vinculada a esta conta.</div><div class="actions"><button class="btn secondary full" onclick="closeModal()">Voltar</button><button class="btn danger full" onclick="logoutAfilia()">Sair da conta</button></div>`);
  } else {
    if(confirm(`${name||email}\n\nDeseja sair da conta?`)) await logoutAfilia();
  }
}

async function logoutAfilia(){
  try{await supabase.auth.signOut({scope:'local'})}catch(e){try{await supabase.auth.signOut()}catch(_){}}
  location.replace('./auth.html?loggedout=1');
}
window.openProfile=openProfile;
window.logoutAfilia=logoutAfilia;

const session=await requireSession();
if(session){
  const profile=document.querySelector('.profile');
  if(profile){
    profile.setAttribute('role','button');
    profile.setAttribute('aria-label','Minha conta');
    profile.setAttribute('tabindex','0');
    profile.style.cursor='pointer';
    profile.onclick=openProfile;
    profile.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openProfile()}};
  }
}
