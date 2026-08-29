const AFILIA_VERSION='0.3.0';
const SUPABASE_URL='https://yjgwlofhordbmjomxcdx.supabase.co';
const SUPABASE_KEY='sb_publishable_qASwZXIwsbouYZpC-X0YWA_675aTqWN';
let afiliaSupabase=null;
let priceMode='normal';
const $=id=>document.getElementById(id);

async function initAuth(){
  try{
    const {createClient}=await import('https://esm.sh/@supabase/supabase-js@2');
    afiliaSupabase=createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    const {data:{session}}=await afiliaSupabase.auth.getSession();
    if(!session){location.replace('./auth.html');return false}
    const profile=document.querySelector('.profile');
    if(profile){
      profile.setAttribute('role','button');
      profile.setAttribute('aria-label','Minha conta');
      profile.style.cursor='pointer';
      profile.onclick=openProfile;
    }
    return true;
  }catch(e){
    console.error('Afilia auth init failed',e);
    alert('Não foi possível validar sua sessão. Verifique sua internet e tente novamente.');
    return false;
  }
}

async function openProfile(){
  if(!afiliaSupabase)return;
  const {data:{user}}=await afiliaSupabase.auth.getUser();
  const email=user?.email||'Conta Afilia';
  const name=user?.user_metadata?.name||'';
  openModal(`<h3>Minha conta</h3><p>${escapeHtml(name||email)}</p><div class="notice good"><strong>Conta ativa</strong><br>${escapeHtml(email)}</div><div class="notice"><strong>Versão ${AFILIA_VERSION}</strong><br>Frontend: GitHub Pages • Backend: Supabase</div><div class="actions"><button class="btn secondary full" onclick="closeModal()">Voltar</button><button class="btn danger full" onclick="logoutAfilia()">Sair da conta</button></div>`)
}

async function logoutAfilia(){
  try{if(afiliaSupabase)await afiliaSupabase.auth.signOut()}catch(e){}
  ['afilia_templates','afilia_active_template','afilia_queue','afilia_connections','afilia_offers','afilia_last_link'].forEach(k=>localStorage.removeItem(k));
  location.replace('./auth.html?loggedout=1');
}
window.openProfile=openProfile;window.logoutAfilia=logoutAfilia;

function go(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));$(id).classList.add('active');document.querySelectorAll('.bottom button').forEach(b=>b.classList.toggle('active',b.dataset.id===id));if(id==='queue')renderQueue();scrollTo({top:0,behavior:'smooth'})}
function toast(t){const e=$('toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2200)}
function detectMarket(url){let u=(url||'').toLowerCase();if(u.includes('shopee'))return 'Shopee';if(u.includes('amazon'))return 'Amazon';if(u.includes('mercadolivre')||u.includes('mercadolibre'))return 'Mercado Livre';if(u.includes('magalu')||u.includes('magazineluiza'))return 'Magalu';return null}
async function pasteLink(){try{const t=await navigator.clipboard.readText();$('linkInput').value=t;analyze()}catch(e){toast('Toque e segure no campo para colar.')}}
function analyze(){const url=$('linkInput').value.trim();const m=detectMarket(url);if(!url){toast('Cole um link primeiro.');return}if(!m){toast('Marketplace ainda não reconhecido.');return}$('marketBadge').textContent='✨ '+m+' detectado';$('detected').classList.add('show');refreshPreview();localStorage.setItem('afilia_last_link',url)}
function setPriceMode(m){priceMode=m;$('useNormal').classList.toggle('active',m==='normal');$('useCoupon').classList.toggle('active',m==='coupon');refreshPreview()}
function money(v){let s=(v||'').trim();if(!s)return '';return s.startsWith('R$')?s:'R$ '+s}
function offerData(){return {url:$('linkInput').value.trim(),product:$('productName').value.trim(),normal:$('normalPrice').value.trim(),coupon:$('couponPrice').value.trim(),pct:$('commissionPct').value.trim(),est:$('commissionEst').value.trim(),affiliate:$('affiliateReady').checked}}
function buildOffer(){const d=offerData();let lines=[];lines.push('🔥 *ACHADINHO DO DIA*','');lines.push('📦 '+(d.product||'[Informe o nome do produto]'),'');if(d.normal)lines.push('💰 Preço: *'+money(d.normal)+'*');if(d.coupon)lines.push('🏷️ Com cupom: *'+money(d.coupon)+'*');if(d.pct||d.est)lines.push('💸 Comissão'+(d.pct?' '+d.pct+'%':'')+(d.est?' • est. '+money(d.est):''));lines.push('','🛒 Pegue aqui:');lines.push(d.affiliate?d.url:'{link de afiliado ainda não confirmado}');lines.push('','⚠️ Preço e cupom podem mudar.');return lines.join('\n')}
function refreshPreview(){$('preview').textContent=buildOffer()}
async function copyOffer(){await navigator.clipboard.writeText(buildOffer());toast('Oferta copiada.')}
function validToPublish(){const d=offerData();if(!d.product||(!d.normal&&!d.coupon)){toast('Confirme produto e preço real.');return false}if(!d.affiliate){toast('Confirme o link de afiliado antes de publicar.');return false}return true}
async function shareOffer(){if(!validToPublish())return;const text=buildOffer();if(navigator.share){try{await navigator.share({text});incOffers();return}catch(e){}}await navigator.clipboard.writeText(text);toast('Texto copiado para compartilhar.');incOffers()}
function getQueue(){try{return JSON.parse(localStorage.getItem('afilia_queue')||'[]')}catch(e){return []}}
function saveQueue(q){localStorage.setItem('afilia_queue',JSON.stringify(q));refreshStats()}
function addQueue(){const d=offerData();if(!d.product||(!d.normal&&!d.coupon)){toast('Preencha produto e preço antes.');return}const q=getQueue();q.unshift({id:Date.now(),market:detectMarket(d.url)||'Marketplace',product:d.product,price:priceMode==='coupon'&&d.coupon?d.coupon:d.normal,text:buildOffer()});saveQueue(q);toast('Adicionado à fila.')}
function removeQueue(id){saveQueue(getQueue().filter(x=>x.id!==id));renderQueue()}
function renderQueue(){const q=getQueue();const box=$('queueList');if(!q.length){box.innerHTML=`<div class="empty"><div class="ico">🗂️</div><h3>Sua fila está vazia</h3><p>Crie uma oferta e toque em “+ Fila”. Ela fica salva neste aparelho.</p><button class="btn primary" style="margin-top:16px" onclick="go('create')">Criar primeira oferta</button></div>`;return}box.innerHTML=q.map(x=>'<div class="card queueItem"><div><b>'+escapeHtml(x.product)+'</b><br><span>'+escapeHtml(x.market)+' • '+escapeHtml(money(x.price))+'</span></div><button onclick="removeQueue('+x.id+')">✕</button></div>').join('')}
function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function incOffers(){localStorage.setItem('afilia_offers',String((+localStorage.getItem('afilia_offers')||0)+1));refreshStats()}
function refreshStats(){$('statOffers').textContent=localStorage.getItem('afilia_offers')||'0';$('statQueue').textContent=String(getQueue().length)}
function importFromUrl(){const p=new URLSearchParams(location.search);const incoming=p.get('url')||p.get('share')||p.get('text');if(incoming){$('linkInput').value=incoming;go('create');setTimeout(analyze,80)}}

(async()=>{const ok=await initAuth();if(!ok)return;refreshStats();refreshPreview();importFromUrl();if('serviceWorker' in navigator){navigator.serviceWorker.register('./sw.js').then(r=>r.update()).catch(()=>{})}})();