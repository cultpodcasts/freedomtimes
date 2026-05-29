import { installGlobalSocksFetch } from './socks-fetch.mjs';
await installGlobalSocksFetch();

import nodeFetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';

const agent = new SocksProxyAgent('socks5://127.0.0.1:9150');
const get = async (label: string, url: string) => {
  console.log(`\n[${label}]`, decodeURIComponent(url));
  const r = await nodeFetch(url, { agent } as any);
  const body = await r.text();
  const items = (body.match(/<item[\s\S]*?<\/item>/gi) ?? []);
  console.log(`  status=${r.status} items=${items.length}`);
  items.slice(0, 8).forEach(item => {
    const title = item.match(/<title><!\[CDATA\[([^\]]+)/)?.[1] ?? item.match(/<title>([^<]+)/)?.[1] ?? '?';
    const pub = item.match(/<pubDate>([^<]+)/)?.[1] ?? '';
    console.log(`  [${pub.slice(0,16)}] ${title.slice(0, 90)}`);
  });
};

const q1 = encodeURIComponent('site:taz.de (sekte OR sekten OR Scientology OR Sekte) when:168h');
const q2 = encodeURIComponent('site:taz.de (sekte OR sekten OR sect OR cult OR cults OR guru OR "geistlicher missbrauch") when:168h');

await get('site:taz.de simple', `https://news.google.com/rss/search?q=${q1}&hl=de&gl=DE&ceid=DE%3Ade`);
await get('site:taz.de full-cult-terms', `https://news.google.com/rss/search?q=${q2}&hl=de&gl=DE&ceid=DE%3Ade`);
