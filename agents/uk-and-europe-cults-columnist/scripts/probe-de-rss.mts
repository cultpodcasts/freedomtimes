const url =
  'https://news.google.com/rss/search?q=((sekte+OR+sekten+OR+Scientology)+OR+(Zwangskontrolle+OR+Gehirnwaesche+OR+Sklaverei+OR+Menschenhandel))+(Deutschland+OR+Oesterreich+OR+Schweiz+OR+Europa)&hl=de&gl=DE&ceid=DE:de';

const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
const xml = await res.text();
const titles = [...xml.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)].map((m) => m[1]);
const pubDates = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => m[1]);
const links = [...xml.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1]);

console.log(`${titles.length - 1} results:\n`);
titles.slice(1).forEach((t, i) => {
  console.log(`${(pubDates[i] ?? '').slice(0, 22)} | ${t}`);
  console.log(`  ${links[i + 1] ?? ''}`);
});
