import fs from 'node:fs/promises';

const file = new URL('./shopee-resolver.js', import.meta.url);
let src = await fs.readFile(file, 'utf8');

const old = "const previous=page.previous||fallbackPrevious(current,rate);";
const replacement = "const previous=null; // strict: never infer previous price";

if (!src.includes(old) && !src.includes(replacement)) {
  throw new Error('Could not locate Shopee previous-price assignment');
}

if (src.includes(old)) {
  src = src.replace(old, replacement);
  await fs.writeFile(file, src);
  console.log('[patch-shopee-strict] disabled inferred previous price');
} else {
  console.log('[patch-shopee-strict] already applied');
}
