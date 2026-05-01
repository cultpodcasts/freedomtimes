import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', '.wrangler', 'state', 'v3', 'r2', 'miniflare-R2BucketObject', 'metadata.sqlite');

const py = String.raw`
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
tables = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
print("TABLES:", [t[0] for t in tables])
for (t,) in tables:
    cols = db.execute("PRAGMA table_info(" + t + ")").fetchall()
    print("  " + t + ": " + str([c[1] for c in cols]))
    rows = db.execute("SELECT * FROM " + t + " LIMIT 3").fetchall()
    for r in rows:
        print("    " + str(r))
`;

const result = execSync(`python -c "${py.replace(/\n/g, '\n').replace(/"/g, '\\"')}" "${dbPath}"`, { encoding: 'utf8' });
console.log(result);


const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = path.join(__dirname, '..', '.wrangler', 'state', 'v3', 'r2', 'miniflare-R2BucketObject', 'metadata.sqlite');
const db = require('better-sqlite3')(dbPath);

const INFECTED_BLOB_PREFIXES = [
  '8c770607df24b4c882bce160d045e28388de4f5a1c9346afea2339f11e40705f',
  'f935aa837e0fdb59172f66187578ce4b95a02c876d8a10933a39937b218f2e84',
];

// Dump all rows so we can find matching blob_ids
const rows = db.prepare('SELECT key, blob_id FROM _cf_KV').all();

console.log(`Total R2 key entries: ${rows.length}`);
console.log('');

const infected = rows.filter(r =>
  r.blob_id && INFECTED_BLOB_PREFIXES.some(prefix => r.blob_id.startsWith(prefix))
);

if (infected.length === 0) {
  console.log('No exact prefix matches. Checking for partial matches...');
  // The blob_id might include a version suffix — try substring match
  const partial = rows.filter(r =>
    r.blob_id && INFECTED_BLOB_PREFIXES.some(prefix => r.blob_id.includes(prefix.slice(0, 32)))
  );
  if (partial.length > 0) {
    console.log('Partial matches:');
    partial.forEach(r => console.log(`  R2 key: ${r.key}  blob_id: ${r.blob_id}`));
  } else {
    console.log('No matches found. Blob IDs may have been removed by Defender.');
    console.log('');
    console.log('Sample blob_ids in DB:');
    rows.slice(0, 5).forEach(r => console.log(`  ${r.blob_id}  ->  ${r.key}`));
  }
} else {
  console.log('INFECTED R2 KEYS:');
  infected.forEach(r => {
    // R2 key is feeds/<sha256-of-url>.xml — extract the hash and reverse-lookup from feeds table
    console.log(`  R2 key: ${r.key}`);
    console.log(`  blob_id: ${r.blob_id}`);
    // Extract the SHA-256 from the key (feeds/<hash>.xml)
    const match = r.key.match(/feeds\/([a-f0-9]{64})\.xml/);
    if (match) {
      console.log(`  URL cache_key (SHA-256): ${match[1]}`);
    }
    console.log('');
  });
}
