import fs from 'node:fs/promises';

const file=new URL('./shopee-resolver.js',import.meta.url);
let src=await fs.readFile(file,'utf8');
const oldTail="console.log('Afilia Shopee resolver + cover + previous price enrichment started');\nfor(;;){try{await tick()}catch(e){console.error('resolver loop',String(e))}await wait(1000)}";
const newTail=`let resolverWatchdog=null;
function armResolverWatchdog(){
  if(resolverWatchdog)clearTimeout(resolverWatchdog);
  resolverWatchdog=setTimeout(()=>{
    console.error(JSON.stringify({event:'shopee_resolver_watchdog_timeout',timeout_ms:90000}));
    process.exit(70);
  },90000);
  resolverWatchdog.unref();
}
console.log('Afilia Shopee resolver + cover + previous price enrichment started');
for(;;){
  armResolverWatchdog();
  try{await tick()}catch(e){console.error('resolver loop',String(e))}
  armResolverWatchdog();
  await wait(1000);
}`;
if(src.includes(oldTail)){
  src=src.replace(oldTail,newTail);
  await fs.writeFile(file,src);
  console.log('[patch-shopee-watchdog] applied');
}else if(src.includes('shopee_resolver_watchdog_timeout')){
  console.log('[patch-shopee-watchdog] already applied');
}else{
  throw new Error('Shopee resolver tail marker not found');
}
