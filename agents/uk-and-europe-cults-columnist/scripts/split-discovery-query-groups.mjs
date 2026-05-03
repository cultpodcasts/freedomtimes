/**
 * Migration / emergency re-split: only works when `discovery-config.json` still has an inline
 * `googleNewsQueryDefinitions.groups` object. After the first split, edit
 * `data/discovery/groups-core.json` and `data/discovery/lang/*.json` directly and maintain
 * `groupFiles` in discovery-config.json by hand.
 *
 * Run from package root: npm run split:discovery-groups
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const CORE_KEYS = [
  'cultCore',
  'ukGeo',
  'ukGeoTight',
  'europeGeo',
  'nordicsGeo',
  'czGeo',
  'balkansGeo',
  'balticsGeo',
  'microstatesGeo',
];

/** Primary language code → group keys owned by that file (cult + country OR lists). */
const LANG_GROUP_KEYS = {
  en: [
    'enHarmSignals',
    'enJournalismSignals',
    'enJusticeSignals',
    'enVictimSignals',
    'enMediaSignals',
    'enWatchlistTerms',
    'enEuropeCountryOr',
  ],
  de: [
    'deAtChTerms',
    'deHarmSignals',
    'deJournalismSignals',
    'deJusticeSignals',
    'deVictimSignals',
    'deMediaSignals',
    'deDachCountryOr',
    'deEuropeCountryOr',
  ],
  fr: [
    'frBeTerms',
    'frHarmSignals',
    'frJournalismSignals',
    'frJusticeSignals',
    'frVictimSignals',
    'frMediaSignals',
    'frFranceBelgGeo',
    'frEuropeCountryOr',
  ],
  it: [
    'itTerms',
    'itHarmSignals',
    'itJournalismSignals',
    'itJusticeSignals',
    'itVictimSignals',
    'itMediaSignals',
    'itItalyGeo',
    'itEuropeCountryOr',
  ],
  es: [
    'esTerms',
    'esHarmSignals',
    'esJournalismSignals',
    'esJusticeSignals',
    'esVictimSignals',
    'esMediaSignals',
    'esSpainGeo',
    'esEuropeCountryOr',
  ],
  nl: [
    'nlTerms',
    'nlHarmSignals',
    'nlJournalismSignals',
    'nlJusticeSignals',
    'nlVictimSignals',
    'nlMediaSignals',
    'nlNetherlandsGeo',
    'nlEuropeCountryOr',
  ],
  pl: [
    'plTerms',
    'plHarmSignals',
    'plJournalismSignals',
    'plJusticeSignals',
    'plVictimSignals',
    'plMediaSignals',
    'plPolandGeo',
    'plEuropeCountryOr',
  ],
  pt: [
    'ptTerms',
    'ptHarmSignals',
    'ptJournalismSignals',
    'ptJusticeSignals',
    'ptVictimSignals',
    'ptMediaSignals',
    'ptPortugalGeo',
    'ptEuropeCountryOr',
  ],
  el: [
    'grTerms',
    'elHarmSignals',
    'elJournalismSignals',
    'elJusticeSignals',
    'elVictimSignals',
    'elMediaSignals',
    'elGreeceGeo',
    'elEuropeCountryOr',
  ],
  ro: [
    'roTerms',
    'roHarmSignals',
    'roJournalismSignals',
    'roJusticeSignals',
    'roVictimSignals',
    'roMediaSignals',
    'roRomaniaGeo',
    'roEuropeCountryOr',
  ],
  fi: [
    'fiTerms',
    'fiHarmSignals',
    'fiJournalismSignals',
    'fiJusticeSignals',
    'fiVictimSignals',
    'fiMediaSignals',
    'fiFinlandGeo',
    'fiEuropeCountryOr',
  ],
  cs: [
    'csTerms',
    'csHarmSignals',
    'csJournalismSignals',
    'csJusticeSignals',
    'csVictimSignals',
    'csMediaSignals',
    'csEuropeCountryOr',
  ],
  sk: [
    'skTerms',
    'skHarmSignals',
    'skJournalismSignals',
    'skJusticeSignals',
    'skVictimSignals',
    'skMediaSignals',
    'skEuropeCountryOr',
  ],
  hu: [
    'huTerms',
    'huHarmSignals',
    'huJournalismSignals',
    'huJusticeSignals',
    'huVictimSignals',
    'huMediaSignals',
    'huEuropeCountryOr',
  ],
  bg: [
    'bgTerms',
    'bgHarmSignals',
    'bgJournalismSignals',
    'bgJusticeSignals',
    'bgVictimSignals',
    'bgMediaSignals',
    'bgEuropeCountryOr',
  ],
  hr: [
    'hrTerms',
    'hrHarmSignals',
    'hrJournalismSignals',
    'hrJusticeSignals',
    'hrVictimSignals',
    'hrMediaSignals',
    'hrEuropeCountryOr',
  ],
  sl: [
    'slTerms',
    'slHarmSignals',
    'slJournalismSignals',
    'slJusticeSignals',
    'slVictimSignals',
    'slMediaSignals',
    'slEuropeCountryOr',
  ],
  sr: [
    'srTerms',
    'srHarmSignals',
    'srJournalismSignals',
    'srJusticeSignals',
    'srVictimSignals',
    'srMediaSignals',
    'srEuropeCountryOr',
  ],
  bs: [
    'bsTerms',
    'bsHarmSignals',
    'bsJournalismSignals',
    'bsJusticeSignals',
    'bsVictimSignals',
    'bsMediaSignals',
    'bsEuropeCountryOr',
  ],
  mk: [
    'mkTerms',
    'mkHarmSignals',
    'mkJournalismSignals',
    'mkJusticeSignals',
    'mkVictimSignals',
    'mkMediaSignals',
    'mkEuropeCountryOr',
  ],
  sq: [
    'sqTerms',
    'sqHarmSignals',
    'sqJournalismSignals',
    'sqJusticeSignals',
    'sqVictimSignals',
    'sqMediaSignals',
    'sqEuropeCountryOr',
  ],
  uk: [
    'ukTerms',
    'ukHarmSignals',
    'ukJournalismSignals',
    'ukJusticeSignals',
    'ukVictimSignals',
    'ukMediaSignals',
    'ukEuropeCountryOr',
  ],
  sv: [
    'svTerms',
    'svHarmSignals',
    'svJournalismSignals',
    'svJusticeSignals',
    'svVictimSignals',
    'svMediaSignals',
    'svEuropeCountryOr',
  ],
  no: [
    'noTerms',
    'noHarmSignals',
    'noJournalismSignals',
    'noJusticeSignals',
    'noVictimSignals',
    'noMediaSignals',
    'noEuropeCountryOr',
  ],
  da: [
    'daTerms',
    'daHarmSignals',
    'daJournalismSignals',
    'daJusticeSignals',
    'daVictimSignals',
    'daMediaSignals',
    'daEuropeCountryOr',
  ],
  is: [
    'isTerms',
    'isHarmSignals',
    'isJournalismSignals',
    'isJusticeSignals',
    'isVictimSignals',
    'isMediaSignals',
    'isEuropeCountryOr',
  ],
  et: [
    'etTerms',
    'etHarmSignals',
    'etJournalismSignals',
    'etJusticeSignals',
    'etVictimSignals',
    'etMediaSignals',
    'etEuropeCountryOr',
  ],
  lv: [
    'lvTerms',
    'lvHarmSignals',
    'lvJournalismSignals',
    'lvJusticeSignals',
    'lvVictimSignals',
    'lvMediaSignals',
    'lvEuropeCountryOr',
  ],
  lt: [
    'ltTerms',
    'ltHarmSignals',
    'ltJournalismSignals',
    'ltJusticeSignals',
    'ltVictimSignals',
    'ltMediaSignals',
    'ltEuropeCountryOr',
  ],
};

function main() {
  const cfgPath = join(root, 'discovery-config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const defs = cfg.googleNewsQueryDefinitions;
  if (!defs?.groups || typeof defs.groups !== 'object') {
    console.error(
      'discovery-config.json has no inline `groups` (already split). Edit data/discovery/*.json and `groupFiles` instead.',
    );
    process.exit(1);
  }
  const groups = defs.groups;

  const assigned = new Set([...CORE_KEYS]);
  for (const keys of Object.values(LANG_GROUP_KEYS)) {
    for (const k of keys) {
      assigned.add(k);
    }
  }

  for (const k of Object.keys(groups)) {
    if (!assigned.has(k)) {
      throw new Error(`Group "${k}" is not listed in CORE_KEYS or LANG_GROUP_KEYS — add it to the split script.`);
    }
  }

  for (const k of assigned) {
    if (!(k in groups)) {
      throw new Error(`Expected group "${k}" in discovery-config.json`);
    }
  }

  function pick(keys) {
    const o = {};
    for (const k of keys) {
      o[k] = groups[k];
    }
    return o;
  }

  mkdirSync(join(root, 'data/discovery/lang'), { recursive: true });

  const corePayload = {
    _docs: 'Shared template groups for googleNewsQueryDefinitions.templates (language-agnostic).',
    groups: pick(CORE_KEYS),
  };
  writeFileSync(join(root, 'data/discovery/groups-core.json'), `${JSON.stringify(corePayload, null, 2)}\n`);

  const langCodes = Object.keys(LANG_GROUP_KEYS).sort();
  for (const lang of langCodes) {
    const payload = {
      _docs: `Language-specific Google News query groups for "${lang}" (cult-related + Europe country OR list).`,
      language: lang,
      groups: pick(LANG_GROUP_KEYS[lang]),
    };
    writeFileSync(join(root, `data/discovery/lang/${lang}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }

  const groupFiles = ['data/discovery/groups-core.json', ...langCodes.map((l) => `data/discovery/lang/${l}.json`)];

  const next = {
    ...cfg,
    googleNewsQueryDefinitions: {
      _docs: 'Inline `groups` removed; loaded from `groupFiles` in discoveryConfig.ts.',
      groupFiles,
      templates: defs.templates,
      rawQueries: defs.rawQueries ?? [],
    },
  };

  writeFileSync(cfgPath, `${JSON.stringify(next, null, 2)}\n`);
  console.error(`Wrote ${groupFiles.length} group files and updated discovery-config.json`);
}

main();
