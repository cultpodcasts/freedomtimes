import { installGlobalSocksFetch } from './socks-fetch.mjs';
await installGlobalSocksFetch();

import nodeFetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';

const agent = new SocksProxyAgent('socks5://127.0.0.1:9150');

const get = async (label: string, url: string) => {
  const r = await nodeFetch(url, { agent } as any);
  const body = await r.text();
  const items = (body.match(/<item[\s\S]*?<\/item>/gi) ?? []);
  const dates = items.map(i => i.match(/<pubDate>([^<]+)/)?.[1] ?? '').filter(Boolean);
  const oldest = dates.sort()[0] ?? 'none';
  const newest = dates.sort().reverse()[0] ?? 'none';
  const titles = items.slice(0, 3).map(i =>
    (i.match(/<title><!\[CDATA\[([^\]]+)/)?.[1] ?? i.match(/<title>([^<]+)/)?.[1] ?? '?').slice(0, 70)
  );
  console.log(`\n[${label}]`);
  console.log(`  status=${r.status} items=${items.length}`);
  console.log(`  oldest=${oldest.slice(0, 16)} newest=${newest.slice(0, 16)}`);
  titles.forEach(t => console.log(`  - ${t}`));
};

const BASE = 'https://news.google.com/rss/search';
const LOCALE = 'hl=de&gl=DE&ceid=DE%3Ade';

console.log('=== TEST 1: when:168h vs when:7d (item count + date range) ===');
await get('when:168h', `${BASE}?q=sekte+when%3A168h&${LOCALE}`);
await get('when:7d',   `${BASE}?q=sekte+when%3A7d&${LOCALE}`);

console.log('\n=== TEST 2: site: vs allinurl: for watchlist query ===');
await get('site:taz.de',     `${BASE}?q=site%3Ataz.de+(sekte+OR+Scientology)+when%3A168h&${LOCALE}`);
await get('allinurl:taz.de', `${BASE}?q=allinurl%3Ataz.de+(sekte+OR+Scientology)+when%3A168h&${LOCALE}`);

console.log('\n=== TEST 3: intitle: vs plain query (false positive reduction) ===');
await get('plain:sekte',          `${BASE}?q=sekte+when%3A168h&${LOCALE}`);
await get('intitle:sekte',        `${BASE}?q=intitle%3Asekte+when%3A168h&${LOCALE}`);

console.log('\n=== TEST 4: when: hour limit — 100h vs 168h vs 240h ===');
await get('when:100h', `${BASE}?q=sekte+when%3A100h&${LOCALE}`);
await get('when:168h', `${BASE}?q=sekte+when%3A168h&${LOCALE}`);
await get('when:240h', `${BASE}?q=sekte+when%3A240h&${LOCALE}`);
