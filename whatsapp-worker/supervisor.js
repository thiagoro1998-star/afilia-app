import { spawn } from 'node:child_process';

const specs = [
  { name: 'whatsapp-discovery', file: 'group-discovery.js' },
  { name: 'shopee', file: 'shopee-resolver.js' }
];
const children = new Map();
const restartTimers = new Map();
let ending = false;

function start(spec) {
  if (ending) return;
  const child = spawn(process.execPath, [spec.file], { stdio: 'inherit', env: process.env });
  children.set(spec.name, child);
  console.log(`[supervisor] started ${spec.name} pid=${child.pid}`);
  child.on('exit', (code, signal) => {
    children.delete(spec.name);
    if (ending) return;
    console.error(`[supervisor] ${spec.name} exited code=${code} signal=${signal}; restarting in 2s`);
    clearTimeout(restartTimers.get(spec.name));
    const timer = setTimeout(() => start(spec), 2000);
    restartTimers.set(spec.name, timer);
  });
  child.on('error', err => console.error(`[supervisor] ${spec.name} spawn error`, err));
}

function stop(code = 0) {
  if (ending) return;
  ending = true;
  for (const timer of restartTimers.values()) clearTimeout(timer);
  for (const child of children.values()) { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(code), 800).unref();
}

for (const spec of specs) start(spec);
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
