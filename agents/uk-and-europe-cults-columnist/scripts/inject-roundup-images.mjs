import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mdPath = path.join(agentRoot, 'reports/drafts/weekly-summary-8-june-2026.md');
const images = JSON.parse(
  readFileSync(path.join(agentRoot, 'reports/drafts/weekly-summary-images.json'), 'utf8'),
);

const byUnit = new Map(images.map((i) => [i.unitId, i]));
const staging = (id) => `https://staging.freedomtimes.news/_emdash/api/media/file/${id}`;

const koofiGuardian =
  'https://i.guim.co.uk/img/media/c06fcccbe2b6bf4d558c999bcc6ec8f8806c9b30/261_0_1998_1598/master/1998.jpg?width=1200&height=630&quality=85&auto=format&fit=crop';

/** Heading prefix -> { url, alt } */
const headingImages = [
  ['## Hoyt Richards', byUnit.get('cluster:auto-0')],
  ['## Maniac Murder', byUnit.get('cluster:auto-1')],
  ['## Andrew Tate', byUnit.get('cluster:auto-3')],
  ['## AllatRa', byUnit.get('cluster:manual-1780920724317')],
  ['## Afghan women', { fileUrl: koofiGuardian, alt: 'Afghan women under Taliban rule' }],
  ['## Sweden: 15-year-old', byUnit.get('story:https%3A%2F%2Fexpressen.se%2Fnyheter%2Fsverige%2F15-arig-pojke-atalad-for-mordbrand-kopplas-till-valdsnatverk%2F')],
  ['## France: Raëlian', byUnit.get('story:https%3A%2F%2Flefigaro.fr%2Fflash-actu%2Fviolences-sexuelles-dans-la-secte-rael-lydia-hadjara-relaxee-de-la-plainte-pour-diffamation-20260604')],
  ['## Switzerland:', byUnit.get('story:https%3A%2F%2Fwatson.ch%2Fblogs%2Fsektenblog%2F270347196-sekten-sind-nicht-weg-die-schweiz-erlebt-einen-neuen-rekord-an-hilferufen')],
  ['## France: Cognac', byUnit.get('story:https%3A%2F%2Fcharentelibre.fr%2Fcharente%2Fcognac%2Fpendant-longtemps-on-les-associait-a-des-sectes-surtout-en-france-l-eglise-protestante-de-cognac-organise-une-conference-sur-le-mouvement-evangelique-ce-samedi-29336232.php')],
  ['## Nottinghamshire:', byUnit.get('story:https%3A%2F%2Fnottinghampost.com%2Fnews%2Flocal-news%2Fhundreds-completely-unacceptable-stickers-plastered-10995735')],
  ['## Netherlands: Danny', byUnit.get('story:https%3A%2F%2Fdenhaagfm.nl%2Fdhfm%2F5115248%2Fdanny-grootveld-doet-boekje-open-over-maasbach-sekte-het-was-gewoon-doen-wat-david-zegt')],
  ['## Netherlands: chat', byUnit.get('story:https%3A%2F%2Foost.nl%2Fnieuws%2F3657882%2Fsekte-hulpverleners-uitgerekend-voor-online-generatie-onvindbaar')],
  ['### St Mary', byUnit.get('cluster:auto-2')],
  ['### Abuja:', byUnit.get('story:https%3A%2F%2Fvaticannews.va%2Fen%2Fafrica%2Fnews%2F2026-06%2Fsouth-africa-church-leaders-call-for-united-action-against-huma.html')],
];

let lines = readFileSync(mdPath, 'utf8').split('\n');

// Drop intro: remove blank line after title and first body paragraph before first ##
const title = lines[0];
const firstH2 = lines.findIndex((l) => l.startsWith('## '));
lines = [title, '', ...lines.slice(firstH2)];

const out = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  out.push(line);
  const match = headingImages.find(([prefix]) => line.startsWith(prefix));
  if (match && match[1]) {
    const img = match[1];
    const url = img.fileUrl ?? staging(img.mediaId);
    const alt = (img.alt ?? 'Illustration').replace(/[\[\]]/g, '');
    const next = lines[i + 1]?.trim() ?? '';
    if (!next.startsWith('![')) {
      out.push('');
      out.push(`![${alt}](${url})`);
    }
  }
}

writeFileSync(mdPath, out.join('\n'));
console.log('updated', mdPath);
