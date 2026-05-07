import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const fontPath = 'scripts/tmp/playfair-display-900.ttf';
const baseGlyph = `
  <text
    x="64"
    y="90"
    text-anchor="middle"
    font-family="Playfair Display"
    font-size="88"
    font-weight="900"
    letter-spacing="-0.01em"
    fill="#000000"
  >ft</text>
`.trim();

const iconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="20" fill="#ffffff"/>
  ${baseGlyph}
</svg>
`.trim();

const icoSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" fill="#ffffff"/>
  ${baseGlyph}
</svg>
`.trim();

async function loadGoogleFont(family, weight) {
  const url = `https://fonts.googleapis.com/css2?family=${family.replace(/\s+/g, '+')}:wght@${weight}&display=swap`;
  const cssRes = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });
  if (!cssRes.ok) {
    throw new Error(`Failed to fetch font CSS: ${cssRes.status}`);
  }

  const css = await cssRes.text();
  const resource = css.match(/src:\s*url\((https:\/\/[^)]+)\)\s*format\('(truetype|opentype)'\)/);
  if (!resource?.[1]) {
    throw new Error('Could not locate a TTF/OTF Playfair Display source in Google Fonts CSS');
  }

  const fontRes = await fetch(resource[1]);
  if (!fontRes.ok) {
    throw new Error(`Failed to fetch font file: ${fontRes.status}`);
  }

  return Buffer.from(await fontRes.arrayBuffer());
}

function renderPng(size, outputPath, svg = iconSvg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: {
      fontFiles: [fontPath],
      loadSystemFonts: false,
      defaultFontFamily: 'Playfair Display',
    },
  });
  writeFileSync(outputPath, resvg.render().asPng());
}

mkdirSync('scripts/tmp', { recursive: true });
const playfair900 = await loadGoogleFont('Playfair Display', 900);
writeFileSync(fontPath, playfair900);

renderPng(16, 'public/.favicon-16.png', icoSvg);
renderPng(24, 'public/.favicon-24.png', icoSvg);
renderPng(32, 'public/.favicon-32.png', icoSvg);
renderPng(48, 'public/.favicon-48.png', icoSvg);
renderPng(64, 'public/.favicon-64.png', icoSvg);
renderPng(180, 'public/apple-touch-icon.png');
renderPng(512, 'public/favicon.png');

const ico = execFileSync(
  'npx',
  ['--yes', 'png-to-ico', 'public/.favicon-16.png', 'public/.favicon-24.png', 'public/.favicon-32.png', 'public/.favicon-48.png', 'public/.favicon-64.png'],
  { encoding: 'buffer' },
);
writeFileSync('public/favicon.ico', ico);

rmSync('public/.favicon-16.png', { force: true });
rmSync('public/.favicon-24.png', { force: true });
rmSync('public/.favicon-32.png', { force: true });
rmSync('public/.favicon-48.png', { force: true });
rmSync('public/.favicon-64.png', { force: true });
