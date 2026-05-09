import fs from 'node:fs/promises';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

import { loadGoogleFontTtf } from './lib/load-google-font-ttf.mjs';

/** Keep in sync with `src/lib/site-brand.ts`. */
const SITE_DISPLAY_NAME = 'freedom times';

const [playfair900, inter700, sourceSerif400] = await Promise.all([
  loadGoogleFontTtf('Playfair Display', 900),
  loadGoogleFontTtf('Inter', 700),
  loadGoogleFontTtf('Source Serif 4', 400),
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
          children: SITE_DISPLAY_NAME,
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
