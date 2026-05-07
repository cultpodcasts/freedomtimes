import fs from 'node:fs/promises';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

async function loadGoogleFont(family, weight) {
  const url = `https://fonts.googleapis.com/css2?family=${family.replace(/\s+/g, '+')}:wght@${weight}&display=swap`;
  const cssRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const css = await cssRes.text();
  const match = css.match(/src:\s*url\((https:\/\/[^)]+)\)\s*format\('(truetype|opentype)'\)/);
  if (!match?.[1]) throw new Error(`font not found: ${family} ${weight}`);
  const fontRes = await fetch(match[1]);
  return await fontRes.arrayBuffer();
}

const [playfair900, inter700, sourceSerif400] = await Promise.all([
  loadGoogleFont('Playfair Display', 900),
  loadGoogleFont('Inter', 700),
  loadGoogleFont('Source Serif 4', 400),
]);

const vdom = {
  type: 'div',
  props: {
    style: {
      width: '1200px',
      height: '630px',
      background: '#ffffff',
      color: '#000000',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '54px 56px',
    },
    children: [
      {
        type: 'div',
        props: {
          style: {
            fontFamily: 'Inter',
            fontSize: '23px',
            fontWeight: 700,
            letterSpacing: '0.045em',
            color: '#555555',
            marginBottom: '20px',
          },
          children: 'UK & Europe | Investigations & Public Interest',
        },
      },
      {
        type: 'div',
        props: {
          style: {
            fontFamily: 'Playfair Display',
            fontSize: '146px',
            fontWeight: 900,
            lineHeight: 0.96,
            letterSpacing: '-0.015em',
            marginBottom: '18px',
          },
          children: 'Freedom Times',
        },
      },
      {
        type: 'div',
        props: {
          style: {
            maxWidth: '1088px',
            fontFamily: 'Source Serif 4',
            fontSize: '32px',
            lineHeight: 1.28,
            fontStyle: 'italic',
            color: '#333333',
            letterSpacing: '0.002em',
          },
          children: 'Telling survivor truths. Protecting sources. Holding cults to account.',
        },
      },
    ],
  },
};

const svg = await satori(vdom, {
  width: 1200,
  height: 630,
  fonts: [
    { name: 'Playfair Display', data: playfair900, weight: 900, style: 'normal' },
    { name: 'Inter', data: inter700, weight: 700, style: 'normal' },
    { name: 'Inter', data: inter700, weight: 600, style: 'normal' },
    { name: 'Source Serif 4', data: sourceSerif400, weight: 400, style: 'normal' },
  ],
});

const png = new Resvg(svg).render().asPng();
await fs.writeFile('public/social/homepage-og.png', png);
