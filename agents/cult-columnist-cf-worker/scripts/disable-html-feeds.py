"""Disable feeds that return HTML instead of valid RSS content (not valid sources)."""
import sqlite3
import os

d1_db = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject',
    '2b35d4d42e3c9f6b5ad5b5579a7b1470c66e69f6b33a31e3f5a0095cc6d18656.sqlite'
)

# Feeds confirmed to return HTML rather than RSS (identified by content scanning R2 blobs)
# All are invalid feed sources; Le Point and Koha Kosovo are highest-risk for Trojan:HTML/Redirector
HTML_FEED_IDS = [
    'brussels-times-be',   # Returns Angular SPA HTML
    'koha-kosovo-xk',      # Returns HTML with active JS (GTM) - HIGH RISK
    'lepoint',             # Returns HTML with DataDome redirect scripts - HIGH RISK
    'newsnet-scot',        # Returns XHTML HTML page
    'scottish-sun',        # Returns access-denied/cache-control HTML
    'telegraph',           # Returns "Access Denied" HTML
]

d1 = sqlite3.connect(d1_db)
tables = [r[0] for r in d1.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print(f'Tables: {tables}')

if 'feeds' not in tables:
    print('ERROR: feeds table not found')
    exit(1)

# Show current state
for fid in HTML_FEED_IDS:
    row = d1.execute('SELECT id, title, url, enabled FROM feeds WHERE id=?', (fid,)).fetchone()
    if row:
        print(f'  {row[0]}: enabled={row[3]}  {row[2]}')
    else:
        print(f'  NOT FOUND: {fid}')

print()
confirm = input('Disable all 6 HTML-returning feeds? (y/n): ').strip().lower()
if confirm != 'y':
    print('Aborted.')
    exit(0)

placeholders = ','.join('?' * len(HTML_FEED_IDS))
d1.execute(f'UPDATE feeds SET enabled=0 WHERE id IN ({placeholders})', HTML_FEED_IDS)
d1.commit()
print(f'Disabled {d1.total_changes} feeds.')
