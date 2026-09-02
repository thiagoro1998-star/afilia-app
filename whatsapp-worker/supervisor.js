import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['worker-v5.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['shopee-resolver.js'], { stdio: 'inherit' })
];
let ending=false;
function stop(code=0){if(ending)return;ending=true;for(const c of children){try{c.kill('SIGTERM')}catch{}}setTimeout(()=>process.exit(code),400).unref()}
for(const c of children)c.on('exit',(code,signal)=>{if(!ending){console.error(`child exited code=${code} signal=${signal}`);stop(code||1)}});
process.on('SIGTERM',()=>stop(0));
process.on('SIGINT',()=>stop(0));
