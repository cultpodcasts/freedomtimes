import { readFileSync } from 'node:fs';

function ogFromHtml(html) {
  const m =
    html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  return m?.[1];
}

const plan = JSON.parse(readFileSync('reports/article-plan.json', 'utf8'));
const article = plan.articles[0];
const byUnit = new Map();
for (const s of article.stories) {
  byUnit.set(s.unitId, [...(byUnit.get(s.unitId) ?? []), s]);
}

const tierA = [
  'theguardian.com',
  'independent.co.uk',
  'dn.se',
  'aftonbladet.se',
  'aftenposten.no',
  'expressen.se',
  'lefigaro.fr',
  'hollywoodreporter.com',
  'nottinghampost.com',
  'watson.ch',
  'charentelibre.fr',
  'vaticannews.va',
];

const results = [];
for (const uid of article.unitIds) {
  const stories = byUnit.get(uid);
  const pick = stories.find((s) => tierA.some((h) => s.host.includes(h))) ?? stories[0];
  let og;
  try {
    const r = await fetch(pick.url, {
      headers: { 'User-Agent': 'FreedomTimesBot/1.0 (+https://freedomtimes.news)' },
      redirect: 'follow',
    });
    const html = await r.text();
    og = ogFromHtml(html);
  } catch (e) {
    og = `ERROR: ${e.message}`;
  }
  results.push({ unitId: uid, label: pick.unitLabel, url: pick.url, host: pick.host, ogImage: og ?? null });
  await new Promise((r) => setTimeout(r, 400));
}

console.log(JSON.stringify(results, null, 2));
