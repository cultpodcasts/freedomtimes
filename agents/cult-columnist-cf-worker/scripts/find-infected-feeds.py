import sqlite3
import os
import re
import hashlib

INFECTED_BLOB_PREFIXES = [
    '8c770607df24b4c882bce160d045e28388de4f5a1c9346afea2339f11e40705f',
    'f935aa837e0fdb59172f66187578ce4b95a02c876d8a10933a39937b218f2e84',
]

script_dir = os.path.dirname(os.path.abspath(__file__))
worker_dir = os.path.dirname(script_dir)

r2_dir = os.path.join(worker_dir, '.wrangler', 'state', 'v3', 'r2', 'miniflare-R2BucketObject')
blobs_dir = os.path.join(worker_dir, '.wrangler', 'state', 'v3', 'r2', 'cult-agent-store-local', 'blobs')
d1_dir = os.path.join(worker_dir, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')

# Find R2 metadata DB (numbered .sqlite)
r2_db_file = next(
    (os.path.join(r2_dir, f) for f in os.listdir(r2_dir)
     if f.endswith('.sqlite') and f not in ('metadata.sqlite',)),
    None
)

# Find D1 DB
d1_db_file = next(
    (os.path.join(d1_dir, f) for f in os.listdir(d1_dir)
     if f.endswith('.sqlite') and f != 'metadata.sqlite'),
    None
)

print(f'R2 DB: {r2_db_file}')
print(f'D1 DB: {d1_db_file}')
print()

# Build feed URL -> metadata lookup indexed by SHA-256(url)
d1 = sqlite3.connect(d1_db_file)
feeds_by_hash = {}
for fid, title, url in d1.execute('SELECT id, title, url FROM feeds WHERE enabled=1').fetchall():
    h = hashlib.sha256(url.encode('utf-8')).hexdigest()
    feeds_by_hash[h] = (fid, title, url)

# Get all R2 object keys
r2 = sqlite3.connect(r2_db_file)
objects = r2.execute('SELECT key, blob_id FROM _mf_objects').fetchall()
print(f'R2 objects: {len(objects)}, blobs dir exists: {os.path.exists(blobs_dir)}')
print()

# HTML/redirector detection patterns (content-based)
REDIRECT_RE = re.compile(
    r'(window\.location|document\.location|location\.href|location\.replace'
    r'|meta[^>]+http-equiv[^>]*refresh)',
    re.IGNORECASE | re.DOTALL
)

suspicious = []

for key, blob_id in objects:
    blob_path = os.path.join(blobs_dir, blob_id)
    if not os.path.exists(blob_path):
        continue

    with open(blob_path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read(8192)

    stripped = content.lstrip()
    is_html = (
        stripped.lower().startswith('<html')
        or stripped.lower().startswith('<!doctype')
        or '<html' in stripped[:500].lower()
    )
    has_redirect = bool(REDIRECT_RE.search(content[:4096]))

    sha = key.replace('feeds/', '').replace('.xml', '')
    feed = feeds_by_hash.get(sha, ('?', '?', key))

    if is_html or has_redirect:
        suspicious.append((feed, key, blob_id, is_html, has_redirect, content[:400]))

print(f'=== SUSPICIOUS FEEDS (HTML body / redirect script) ===')
if not suspicious:
    print('None found.')
else:
    for (fid, title, url), key, blob_id, is_html, has_redirect, preview in suspicious:
        print(f'URL:   {url}')
        print(f'ID:    {fid}  |  Title: {title}')
        print(f'Flags: html={is_html}, redirect={has_redirect}')
        print(f'Preview: {repr(preview[:200])}')
        print()

print(f'\nTotal suspicious: {len(suspicious)} of {len(objects)} feeds that connected')


INFECTED_BLOB_PREFIXES = [
    '8c770607df24b4c882bce160d045e28388de4f5a1c9346afea2339f11e40705f',
    'f935aa837e0fdb59172f66187578ce4b95a02c876d8a10933a39937b218f2e84',
]

script_dir = os.path.dirname(os.path.abspath(__file__))
worker_dir = os.path.dirname(script_dir)
r2_dir = os.path.join(worker_dir, '.wrangler', 'state', 'v3', 'r2', 'miniflare-R2BucketObject')
d1_dir = os.path.join(worker_dir, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')

infected_keys = []

# Search all SQLite files in R2 state
for fname in os.listdir(r2_dir):
    if not fname.endswith('.sqlite'):
        continue
    db = sqlite3.connect(os.path.join(r2_dir, fname))
    tables = [t[0] for t in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    print(f"{fname} -> tables: {tables}")
    for t in tables:
        cols = [c[1] for c in db.execute(f"PRAGMA table_info({t})").fetchall()]
        print(f"  {t}: {cols}")
        for row in db.execute(f"SELECT * FROM {t} LIMIT 2").fetchall():
            print(f"    {str(row)[:200]}")
        # Check for infected blob refs
        for row in db.execute(f"SELECT * FROM {t}").fetchall():
            row_str = str(row)
            for prefix in INFECTED_BLOB_PREFIXES:
                if prefix[:16] in row_str:
                    print(f"\n  *** INFECTED MATCH in {fname}/{t}: {row}")
                    infected_keys.append(row)

print(f"\nTotal infected entries found: {len(infected_keys)}")

# Also search the D1 db correctly
print(f"\nSearching D1 at: {d1_dir}")
if os.path.exists(d1_dir):
    for fname in os.listdir(d1_dir):
        if not fname.endswith('.sqlite') or fname == 'metadata.sqlite':
            continue
        d1 = sqlite3.connect(os.path.join(d1_dir, fname))
        tables = [t[0] for t in d1.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        if 'feeds' in tables:
            print(f"  Found feeds table in {fname}")
            feeds = d1.execute("SELECT url FROM feeds WHERE enabled=1").fetchall()
            print(f"  {len(feeds)} enabled feeds")
            for (url,) in feeds:
                h = hashlib.sha256(url.encode('utf-8')).hexdigest()
                for prefix in INFECTED_BLOB_PREFIXES:
                    if h.startswith(prefix[:32]):
                        print(f"\n  *** INFECTED FEED: {url}")


INFECTED_BLOB_PREFIXES = [
    '8c770607df24b4c882bce160d045e28388de4f5a1c9346afea2339f11e40705f',
    'f935aa837e0fdb59172f66187578ce4b95a02c876d8a10933a39937b218f2e84',
]

script_dir = os.path.dirname(os.path.abspath(__file__))
worker_dir = os.path.dirname(script_dir)
r2_db = os.path.join(worker_dir, '.wrangler', 'state', 'v3', 'r2', 'miniflare-R2BucketObject', 'metadata.sqlite')
d1_db_dir = os.path.join(worker_dir, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')

print(f"R2 metadata DB: {r2_db}")
print(f"Exists: {os.path.exists(r2_db)}\n")

r2 = sqlite3.connect(r2_db)

# Discover schema
tables = r2.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
print("Tables in R2 metadata DB:")
for (t,) in tables:
    cols = r2.execute(f"PRAGMA table_info({t})").fetchall()
    print(f"  {t}: {[c[1] for c in cols]}")

print()

# Try to find key->blob mapping in each table
infected_keys = []
for (t,) in tables:
    cols = r2.execute(f"PRAGMA table_info({t})").fetchall()
    col_names = [c[1] for c in cols]
    # Look for a column that might hold blob IDs
    blob_col = next((c for c in col_names if 'blob' in c.lower() or 'hash' in c.lower() or 'id' in c.lower()), None)
    key_col = next((c for c in col_names if 'key' in c.lower() or 'name' in c.lower()), None)
    if blob_col and key_col:
        rows = r2.execute(f"SELECT {key_col}, {blob_col} FROM {t}").fetchall()
        for key, blob_id in rows:
            if blob_id and any(str(blob_id).startswith(p[:16]) for p in INFECTED_BLOB_PREFIXES):
                infected_keys.append((key, blob_id))
                print(f"MATCH in {t}: key={key}  blob_id={blob_id}")

print(f"\nInfected R2 keys found: {len(infected_keys)}")

if not infected_keys:
    # Show sample rows from each table to understand format
    print("\nShowing sample rows from each table:")
    for (t,) in tables:
        rows = r2.execute(f"SELECT * FROM {t} LIMIT 3").fetchall()
        print(f"  {t}:")
        for r in rows:
            print(f"    {r}")

# Cross-reference with feeds DB to find the host
# The R2 key format is feeds/<sha256-of-url>.xml
# Find the D1 database
if os.path.exists(d1_db_dir):
    dbs = [f for f in os.listdir(d1_db_dir) if f.endswith('.sqlite')]
    print(f"\nD1 databases: {dbs}")
    for dbfile in dbs:
        d1 = sqlite3.connect(os.path.join(d1_db_dir, dbfile))
        try:
            feeds = d1.execute("SELECT url FROM feeds WHERE enabled=1").fetchall()
            print(f"\nChecking {len(feeds)} enabled feeds in {dbfile}...")
            for (url,) in feeds:
                h = hashlib.sha256(url.encode('utf-8')).hexdigest()
                for key, blob_id in infected_keys:
                    if h in (key or ''):
                        print(f"\n*** INFECTED FEED FOUND ***")
                        print(f"  URL: {url}")
                        print(f"  SHA-256: {h}")
                        print(f"  R2 key: {key}")
        except Exception as e:
            print(f"  Error: {e}")
