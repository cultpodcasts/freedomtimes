import fs from 'node:fs';
import path from 'node:path';

const chunksDir = path.resolve('dist/server/chunks');

if (!fs.existsSync(chunksDir)) {
  console.warn('[patch-cloudflare-bundle] chunks directory not found, skipping');
  process.exit(0);
}

const files = fs
  .readdirSync(chunksDir)
  .filter((name) => name.startsWith('adapt-sandbox-entry_') && name.endsWith('.mjs'));

let patched = 0;
for (const name of files) {
  const fullPath = path.join(chunksDir, name);
  const original = fs.readFileSync(fullPath, 'utf8');
  const updated = original.replaceAll('createRequire(import.meta.url)', "createRequire('/')");
  if (updated !== original) {
    fs.writeFileSync(fullPath, updated, 'utf8');
    patched += 1;
  }
}

console.log(`[patch-cloudflare-bundle] patched ${patched} file(s)`);
