await import('./app-core.js?v=053');
await import('./templates.js?v=002');
await import('./mirror.js?v=003');
await import('./whatsapp-ui-fix.js?v=053');

let mirrorGroupUxBusy=false;
let mirrorGroupUxOrder=new Map();
let mirrorGroupUxFetchedAt=0;
let mgTimer=null;
let mgMirrorHooksWrapped=false;

const mgDb=()=>window.afiliaSupabase||null;
const mgSleep=ms=>new Promise(r=>setTimeout(r,ms));

async function mgUid(){
  const db=mgDb();
  if(!db)return null;
  const{data:{session}}=await db.auth.getSession();
  return session?.user?.id||null;
}
function mgToast(message){
  const el=document.getElementById('toast');
  if(!el)return;
  el.textContent=message;
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),3200);
}
function mgInjectStyles(){
  if(document.getElementById('afilia-mirror-ux-styles'))return;
  const s=document.createElement('style');
  s.id='afilia-mirror-ux-styles';
  s.textContent=`
  #modalBody:has(#mirSource){padding-bottom:8px}
  #modalBody:has(#mirSource)>p{margin-bottom:14px}
  #modalBody:has(#mirSource) label{margin-top:13px}
  #modalBody:has(#mirSource) .field{padding:13px 14px;border-radius:14px;background:#0b1014}
  #mirRefreshGroups{margin:5px 0 12px!important;padding:9px 11px!important;border-radius:12px!important;font-size:10px!important;width:auto!important;display:inline-flex!important;align-items:center;gap:6px}
  .mgTargetPicker{margin-top:2px}
  .mgTargetToggle{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#0b1014;border:1px solid #2b343e;border-radius:15px;color:#eef2f6;padding:13px 14px;font-size:12px;font-weight:900;cursor:pointer;text-align:left}
  .mgTargetToggle:hover{border-color:#3a4652}
  .mgTargetToggle strong{font-size:12px}
  .mgTargetBadge{min-width:42px;text-align:center;border-radius:999px;background:#202831;color:#c7d0d9;padding:6px 8px;font-size:9px}
  .mgTargetBadge.has{background:rgba(212,255,50,.12);color:#d4ff32}
  .mgTargetPanel{display:none;margin-top:8px;border:1px solid #29323b;background:#0a0e12;border-radius:16px;padding:10px}
  .mgTargetPanel.open{display:block}
  .mgTargetSearchRow{display:grid;grid-template-columns:1fr auto;gap:7px;align-items:center}
  .mgTargetSearch{width:100%;border:1px solid #2a343e;background:#11171c;color:white;border-radius:12px;padding:10px 11px;font-size:11px;outline:0}
  .mgTargetMiniBtn{border:1px solid #303a44;background:#171e25;color:#cbd4dc;border-radius:11px;padding:9px 10px;font-size:9px;font-weight:900;cursor:pointer}
  .mgTargetTools{display:flex;gap:6px;margin-top:8px}
  .mgTargetTools .mgTargetMiniBtn{flex:1}
  #mirTargets.mgTargetList{max-height:235px;margin-top:8px;padding-right:2px}
  #mirTargets.mgTargetList .mirrorCheckRow{padding:9px 10px;border-radius:11px;background:#0e1419}
  #mirTargets.mgTargetList .mirrorCheckRow span{font-size:10px}
  #mirTargetCounter.mgHiddenCounter{display:none!important}
  .mgSelectedTargets{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 0}
  .mgSelectedTargets:empty{display:none}
  .mgTargetChip{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:6px 8px;border-radius:999px;background:rgba(212,255,50,.09);border:1px solid rgba(212,255,50,.18);color:#dfe8ca;font-size:9px;font-weight:800}
  .mgTargetChip span{max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mgTargetChip button{border:0;background:transparent;color:#99a57a;font-size:12px;padding:0;cursor:pointer}
  .mgTargetMore{display:inline-flex;align-items:center;padding:6px 8px;border-radius:999px;background:#1a2128;color:#95a0aa;font-size:9px;font-weight:900}
  .mgPlatformGrid{display:grid!important;grid-template-columns:1fr 1fr;gap:7px!important;max-height:none!important}
  .mgPlatformGrid .mirrorCheckRow{min-height:52px;padding:10px;border-radius:13px;position:relative;cursor:pointer}
  .mgPlatformGrid .mirrorCheckRow:has(input:checked){border-color:rgba(212,255,50,.42);background:rgba(212,255,50,.06)}
  .mgPlatformIcon{width:27px;height:27px;border-radius:9px;background:#1a2229;display:grid;place-items:center;font-size:10px;font-weight:1000;flex:0 0 27px}
  .mgPlatformGrid .mirrorPlatformNote{position:absolute;right:8px;bottom:6px}
  .mgAdvanced{margin-top:12px;border:1px solid #29323b;border-radius:15px;background:#0c1115;overflow:hidden}
  .mgAdvanced summary{list-style:none;cursor:pointer;padding:12px 13px;color:#c9d2db;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:space-between}
  .mgAdvanced summary::-webkit-details-marker{display:none}
  .mgAdvanced summary:after{content:'⌄';color:#788491;font-size:13px}
  .mgAdvanced[open] summary:after{transform:rotate(180deg)}
  .mgAdvancedBody{padding:0 11px 11px;border-top:1px solid #222a31}
  .mgAdvancedBody label{margin-top:11px!important}
  .mgSecurityMini{margin:11px 0 2px;padding:9px 10px;border-radius:12px;background:rgba(69,223,142,.05);border:1px solid rgba(69,223,142,.13);color:#8fa39a;font-size:9px;line-height:1.4}
  .mgMirrorSummary{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px;padding:9px 10px;border-radius:13px;background:#0c1115;border:1px solid #242d35}
  .mgSummaryPill{padding:5px 7px;border-radius:999px;background:#181f26;color:#9ba7b2;font-size:8.5px;font-weight:900}
  .mgSummaryPill.good{background:rgba(69,223,142,.08);color:#79e9aa}
  .mgSummaryPill.lime{background:rgba(212,255,50,.08);color:#d4ff32}
  #modalBody:has(#mirSource) .actions{position:sticky;bottom:-16px;z-index:4;background:linear-gradient(transparent,#11151a 24%);padding:18px 0 4px;margin-top:8px}
  #modalBody:has(#mirSource) .actions .btn{min-height:45px}
  .mirrorItem{box-shadow:0 10px 28px rgba(0,0,0,.12)}
  .mirrorActions button{transition:.15s}
  .mirrorActions button:active{transform:scale(.98)}
  @media(max-width:420px){
    .mgPlatformGrid{grid-template-columns:1fr}
    .mgTargetChip span{max-width:135px}
  }`;
  document.head.appendChild(s);
}

async function mgLoadOrder(force=false){
  if(!force&&Date.now()-mirrorGroupUxFetchedAt<10000&&mirrorGroupUxOrder.size)return;
  const db=mgDb(),uid=await mgUid();
  if(!db||!uid)return;
  const{data,error}=await db.from('whatsapp_group_refs')
    .select('id,created_at,updated_at')
    .eq('user_id',uid)
    .eq('name_status','verified')
    .order('created_at',{ascending:false})
    .order('updated_at',{ascending:false});
  if(error){console.warn('mirror_group_order_error',error);return}
  mirrorGroupUxOrder=new Map((data||[]).map((g,i)=>[g.id,i]));
  mirrorGroupUxFetchedAt=Date.now();
}
function mgRank(id){return mirrorGroupUxOrder.has(id)?mirrorGroupUxOrder.get(id):999999}
function mgReorderVisibleGroups(){
  const source=document.getElementById('mirSource');
  if(source){
    const selected=source.value;
    const options=[...source.options];
    const placeholder=options.find(o=>!o.value)||null;
    const groups=options.filter(o=>o.value).sort((a,b)=>mgRank(a.value)-mgRank(b.value));
    source.innerHTML='';
    if(placeholder)source.appendChild(placeholder);
    for(const o of groups)source.appendChild(o);
    source.value=selected;
  }
  const host=document.getElementById('mirTargets');
  if(host){
    const rows=[...host.querySelectorAll('.mirrorCheckRow')];
    rows.sort((a,b)=>mgRank(a.querySelector('.mirTarget')?.value||'')-mgRank(b.querySelector('.mirTarget')?.value||''));
    for(const row of rows)host.appendChild(row);
  }
}
function mgSnapshotForm(){
  return{
    name:document.getElementById('mirName')?.value||'',
    source:document.getElementById('mirSource')?.value||'',
    targets:[...document.querySelectorAll('.mirTarget:checked')].map(x=>x.value),
    platforms:[...document.querySelectorAll('.mirPlatform:checked')].map(x=>x.value),
    start:document.getElementById('mirStart')?.value||'00:00',
    end:document.getElementById('mirEnd')?.value||'23:59',
    interval:document.getElementById('mirInterval')?.value||'0',
    device:document.getElementById('mirDevice')?.value||'',
    active:!!document.getElementById('mirActive')?.checked,
    creating:/Criar novo espelhamento/i.test(document.getElementById('modalBody')?.textContent||'')
  };
}
async function mgWaitForForm(timeout=5000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    if(document.getElementById('mirSource'))return true;
    await mgSleep(100);
  }
  return false;
}
function mgRestoreForm(s){
  const set=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val};
  set('mirName',s.name);
  set('mirSource',s.source);
  set('mirStart',s.start);
  set('mirEnd',s.end);
  set('mirInterval',s.interval);
  set('mirDevice',s.device);
  const a=document.getElementById('mirActive');
  if(a)a.checked=s.active;
  if(typeof window.renderMirrorTargets==='function')window.renderMirrorTargets();
  for(const el of document.querySelectorAll('.mirTarget'))el.checked=s.targets.includes(el.value);
  for(const el of document.querySelectorAll('.mirPlatform'))if(!el.disabled)el.checked=s.platforms.includes(el.value);
  if(typeof window.updateMirrorTargetCounter==='function')window.updateMirrorTargetCounter();
  mgReorderVisibleGroups();
  setTimeout(()=>{mgRefreshTargetPicker();mgUpdateFormSummary()},0);
}

async function refreshMirrorWhatsAppGroups(){
  if(mirrorGroupUxBusy)return;
  const db=mgDb(),uid=await mgUid();
  if(!db||!uid){mgToast('Sessão do Afilia não encontrada');return}
  const button=document.getElementById('mirRefreshGroups'),state=mgSnapshotForm();
  mirrorGroupUxBusy=true;
  if(button){button.disabled=true;button.textContent='↻ Sincronizando...'}
  try{
    let connectionId=null;
    if(state.source){
      const{data}=await db.from('whatsapp_group_refs')
        .select('connection_id')
        .eq('id',state.source)
        .eq('user_id',uid)
        .maybeSingle();
      connectionId=data?.connection_id||null;
    }
    if(!connectionId){
      const{data,error}=await db.from('whatsapp_connections')
        .select('id,status,session_secret_configured,last_heartbeat_at,updated_at')
        .eq('user_id',uid)
        .eq('session_secret_configured',true)
        .order('last_heartbeat_at',{ascending:false,nullsFirst:false})
        .order('updated_at',{ascending:false})
        .limit(1)
        .maybeSingle();
      if(error)throw error;
      connectionId=data?.id||null;
    }
    if(!connectionId)throw new Error('Nenhum WhatsApp vinculado para sincronizar');
    mgToast('Sincronizando grupos do WhatsApp...');
    const{data,error}=await db.functions.invoke('whatsapp-sync-groups',{body:{connection_id:connectionId}});
    if(error)throw error;
    if(data?.error)throw new Error(data.detail||data.error);
    await mgLoadOrder(true);
    if(state.creating&&typeof window.newMirrorRule==='function'){
      window.newMirrorRule();
      if(await mgWaitForForm()){
        mgRestoreForm(state);
        await mgLoadOrder(true);
        mgReorderVisibleGroups();
      }
    }
    mgToast(`Grupos atualizados${Number(data?.groups)>=0?` • ${data.groups} encontrados`:''}`);
  }catch(e){
    console.error('mirror_group_sync_error',e);
    mgToast(String(e?.message||'Não foi possível atualizar os grupos'));
  }finally{
    mirrorGroupUxBusy=false;
    const b=document.getElementById('mirRefreshGroups');
    if(b){b.disabled=false;b.textContent='↻ Atualizar grupos'}
  }
}
window.refreshMirrorWhatsAppGroups=refreshMirrorWhatsAppGroups;

function mgTargetName(checkbox){
  const row=checkbox?.closest('.mirrorCheckRow');
  return (row?.querySelector('span')?.childNodes?.[0]?.textContent||row?.textContent||'Grupo').trim();
}
function mgSelectedTargetChecks(){
  return [...document.querySelectorAll('.mirTarget:checked')];
}
function mgApplyTargetFilter(){
  const input=document.getElementById('mgTargetSearch');
  const q=(input?.value||'').trim().toLocaleLowerCase('pt-BR');
  const host=document.getElementById('mirTargets');
  if(!host)return;
  for(const row of host.querySelectorAll('.mirrorCheckRow')){
    const name=(row.textContent||'').toLocaleLowerCase('pt-BR');
    row.style.display=!q||name.includes(q)?'flex':'none';
  }
}
function mgRefreshTargetPicker(){
  const checks=mgSelectedTargetChecks();
  const title=document.getElementById('mgTargetTitle');
  const badge=document.getElementById('mgTargetCountBadge');
  const chips=document.getElementById('mgSelectedTargets');
  if(title)title.textContent=checks.length?`${checks.length} grupo${checks.length===1?'':'s'} selecionado${checks.length===1?'':'s'}`:'Selecionar grupos destino';
  if(badge){
    badge.textContent=`${checks.length}/20`;
    badge.className='mgTargetBadge'+(checks.length?' has':'');
  }
  if(chips){
    const first=checks.slice(0,4);
    chips.innerHTML=first.map(c=>`<span class="mgTargetChip"><span>${mgEscape(mgTargetName(c))}</span><button type="button" data-remove-target="${mgEscape(c.value)}" aria-label="Remover">×</button></span>`).join('')+(checks.length>4?`<span class="mgTargetMore">+${checks.length-4}</span>`:'');
  }
  const original=document.getElementById('mirTargetCounter');
  if(original)original.classList.add('mgHiddenCounter');
  mgApplyTargetFilter();
  mgUpdateFormSummary();
}
function mgEscape(s){
  return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function mgRemoveTarget(id){
  const c=[...document.querySelectorAll('.mirTarget')].find(x=>x.value===id);
  if(!c)return;
  c.checked=false;
  if(typeof window.updateMirrorTargetCounter==='function')window.updateMirrorTargetCounter(c);
  mgRefreshTargetPicker();
}
function mgToggleTargetPanel(){
  document.getElementById('mgTargetPanel')?.classList.toggle('open');
}
function mgClearTargets(){
  for(const c of document.querySelectorAll('.mirTarget:checked'))c.checked=false;
  if(typeof window.updateMirrorTargetCounter==='function')window.updateMirrorTargetCounter();
  mgRefreshTargetPicker();
}
function mgSelectVisibleTargets(){
  const rows=[...document.querySelectorAll('#mirTargets .mirrorCheckRow')].filter(r=>r.style.display!=='none');
  const current=mgSelectedTargetChecks().length;
  let left=Math.max(0,20-current);
  for(const row of rows){
    const c=row.querySelector('.mirTarget');
    if(!c||c.checked||left<=0)continue;
    c.checked=true;
    left--;
  }
  if(typeof window.updateMirrorTargetCounter==='function')window.updateMirrorTargetCounter();
  mgRefreshTargetPicker();
}
window.mgRemoveTarget=mgRemoveTarget;
window.mgToggleTargetPanel=mgToggleTargetPanel;
window.mgClearTargets=mgClearTargets;
window.mgSelectVisibleTargets=mgSelectVisibleTargets;

function mgEnhanceTargetPicker(){
  const host=document.getElementById('mirTargets');
  if(!host)return;
  let picker=document.getElementById('mgTargetPicker');
  if(!picker){
    picker=document.createElement('div');
    picker.id='mgTargetPicker';
    picker.className='mgTargetPicker';
    picker.innerHTML=`
      <button type="button" class="mgTargetToggle" onclick="mgToggleTargetPanel()">
        <strong id="mgTargetTitle">Selecionar grupos destino</strong>
        <span id="mgTargetCountBadge" class="mgTargetBadge">0/20</span>
      </button>
      <div id="mgSelectedTargets" class="mgSelectedTargets"></div>
      <div id="mgTargetPanel" class="mgTargetPanel">
        <div class="mgTargetSearchRow">
          <input id="mgTargetSearch" class="mgTargetSearch" placeholder="Buscar grupo..." autocomplete="off">
          <button type="button" class="mgTargetMiniBtn" onclick="mgClearTargets()">Limpar</button>
        </div>
        <div class="mgTargetTools">
          <button type="button" class="mgTargetMiniBtn" onclick="mgSelectVisibleTargets()">Selecionar visíveis</button>
          <button type="button" class="mgTargetMiniBtn" onclick="refreshMirrorWhatsAppGroups()">↻ Atualizar grupos</button>
        </div>
      </div>`;
    host.parentNode.insertBefore(picker,host);
    const panel=picker.querySelector('#mgTargetPanel');
    panel.appendChild(host);
    const counter=document.getElementById('mirTargetCounter');
    if(counter)panel.appendChild(counter);
    picker.querySelector('#mgTargetSearch')?.addEventListener('input',mgApplyTargetFilter);
    picker.querySelector('#mgSelectedTargets')?.addEventListener('click',e=>{
      const btn=e.target.closest('[data-remove-target]');
      if(btn)mgRemoveTarget(btn.getAttribute('data-remove-target'));
    });
  }
  host.classList.add('mgTargetList');
  mgRefreshTargetPicker();
}

function mgEnhancePlatforms(){
  const first=document.querySelector('.mirPlatform');
  const host=first?.closest('.mirrorChecks');
  if(!host||host.classList.contains('mgPlatformGrid'))return;
  host.classList.add('mgPlatformGrid');
  const icons={'mercado-livre':'ML','shopee':'S','amazon':'a','magalu':'M','tiktok':'♪'};
  for(const row of host.querySelectorAll('.mirrorCheckRow')){
    const input=row.querySelector('.mirPlatform');
    if(!input)continue;
    const icon=document.createElement('span');
    icon.className='mgPlatformIcon';
    icon.textContent=icons[input.value]||'•';
    input.insertAdjacentElement('afterend',icon);
    input.addEventListener('change',()=>{mgUpdateAdvancedVisibility();mgUpdateFormSummary()});
  }
}
function mgEnhanceAdvanced(){
  const device=document.getElementById('mirDevice');
  if(!device||document.getElementById('mgAdvanced'))return;
  const label=device.previousElementSibling;
  const diag=device.nextElementSibling?.classList?.contains('mirrorDiag')?device.nextElementSibling:null;
  const details=document.createElement('details');
  details.id='mgAdvanced';
  details.className='mgAdvanced';
  details.innerHTML='<summary>⚙️ Configurações avançadas</summary><div class="mgAdvancedBody"></div>';
  label?.parentNode?.insertBefore(details,label);
  const body=details.querySelector('.mgAdvancedBody');
  if(label)body.appendChild(label);
  body.appendChild(device);
  if(diag)body.appendChild(diag);
  const security=[...document.querySelectorAll('#modalBody .notice.warn')].find(x=>/Segurança multiusuário/i.test(x.textContent||''));
  if(security){
    const mini=document.createElement('div');
    mini.className='mgSecurityMini';
    mini.textContent='🔒 Origem, destinos e extensão são isolados por conta.';
    security.replaceWith(mini);
    body.appendChild(mini);
  }
  mgUpdateAdvancedVisibility();
}
function mgUpdateAdvancedVisibility(){
  const details=document.getElementById('mgAdvanced');
  if(!details)return;
  const hasML=!!document.querySelector('.mirPlatform[value="mercado-livre"]:checked');
  details.style.display=hasML?'block':'none';
}

function mgCreateFormSummary(){
  if(document.getElementById('mgMirrorSummary'))return;
  const source=document.getElementById('mirSource');
  if(!source)return;
  const modal=document.getElementById('modalBody');
  const p=modal?.querySelector(':scope > p');
  const summary=document.createElement('div');
  summary.id='mgMirrorSummary';
  summary.className='mgMirrorSummary';
  (p||modal?.querySelector('h3'))?.insertAdjacentElement('afterend',summary);
}
function mgUpdateFormSummary(){
  const el=document.getElementById('mgMirrorSummary');
  if(!el)return;
  const source=document.getElementById('mirSource');
  const sourceName=source?.selectedOptions?.[0]?.textContent?.trim();
  const n=mgSelectedTargetChecks().length;
  const platforms=[...document.querySelectorAll('.mirPlatform:checked')].map(x=>x.closest('.mirrorCheckRow')?.textContent?.replace(/em breve/ig,'').trim()).filter(Boolean);
  const interval=document.getElementById('mirInterval')?.selectedOptions?.[0]?.textContent||'Realtime';
  el.innerHTML=[
    source?.value?`<span class="mgSummaryPill good">Origem: ${mgEscape(sourceName)}</span>`:'<span class="mgSummaryPill">Escolha a origem</span>',
    n?`<span class="mgSummaryPill lime">${n} destino${n===1?'':'s'}</span>`:'<span class="mgSummaryPill">Sem destino</span>',
    platforms.length?`<span class="mgSummaryPill">${mgEscape(platforms.join(' + '))}</span>`:'',
    `<span class="mgSummaryPill">${mgEscape(interval)}</span>`
  ].join('');
}
function mgBindSummaryListeners(){
  for(const id of ['mirSource','mirInterval','mirStart','mirEnd']){
    const el=document.getElementById(id);
    if(el&&!el.dataset.mgBound){
      el.dataset.mgBound='1';
      el.addEventListener('change',()=>setTimeout(()=>{mgRefreshTargetPicker();mgUpdateFormSummary()},0));
    }
  }
}

function mgWrapMirrorHooks(){
  if(mgMirrorHooksWrapped)return;
  if(typeof window.updateMirrorTargetCounter==='function'){
    const original=window.updateMirrorTargetCounter;
    window.updateMirrorTargetCounter=function(changed){
      const out=original(changed);
      setTimeout(()=>{mgRefreshTargetPicker();mgUpdateFormSummary()},0);
      return out;
    };
  }
  if(typeof window.renderMirrorTargets==='function'){
    const original=window.renderMirrorTargets;
    window.renderMirrorTargets=function(){
      const out=original();
      setTimeout(()=>{mgReorderVisibleGroups();mgEnhanceTargetPicker();mgRefreshTargetPicker()},0);
      return out;
    };
  }
  mgMirrorHooksWrapped=true;
}

async function mgEnhanceForm(){
  const source=document.getElementById('mirSource');
  if(!source)return;
  mgInjectStyles();
  mgWrapMirrorHooks();
  if(!document.getElementById('mirRefreshGroups')){
    const btn=document.createElement('button');
    btn.id='mirRefreshGroups';
    btn.type='button';
    btn.className='btn secondary';
    btn.textContent='↻ Atualizar grupos';
    btn.onclick=refreshMirrorWhatsAppGroups;
    source.insertAdjacentElement('afterend',btn);
  }
  await mgLoadOrder();
  mgReorderVisibleGroups();
  mgCreateFormSummary();
  mgEnhanceTargetPicker();
  mgEnhancePlatforms();
  mgEnhanceAdvanced();
  mgBindSummaryListeners();
  mgRefreshTargetPicker();
  mgUpdateFormSummary();
}

mgInjectStyles();
const mgObserver=new MutationObserver(()=>{
  clearTimeout(mgTimer);
  mgTimer=setTimeout(()=>mgEnhanceForm().catch(console.warn),70);
});
if(document.body)mgObserver.observe(document.body,{childList:true,subtree:true});
else document.addEventListener('DOMContentLoaded',()=>mgObserver.observe(document.body,{childList:true,subtree:true}));
mgEnhanceForm().catch(()=>{});
