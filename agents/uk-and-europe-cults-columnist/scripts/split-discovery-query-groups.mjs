/**
 * Migration / emergency re-split: only works when `discovery-config.json` still has an inline
 * `googleNewsQueryDefinitions.groups` object. After the first split, edit
 * `data/discovery/groups-core.json`, `data/discovery/region/*.json`, and `data/discovery/lang/*.json`
 * and maintain `groupFiles` in discovery-config.json by hand.
 *
 * Run from package root: npm run split:discovery-groups
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/** Keys written to `data/discovery/groups-core.json` (minimal shared Latin cult stems). */
const CORE_KEYS = ['cultCore'];

/** Sub-regional / cross-language geo and cult OR-groups → `data/discovery/region/*.json`. */
const REGION_FILES = [
  {
    rel: 'data/discovery/region/region-europe-geo.json',
    _docs: 'Broad European geography tokens for generic Google News q= (not a single country).',
    keys: ['europeGeo'],
  },
  {
    rel: 'data/discovery/region/region-uk-ie.json',
    _docs: 'UK and Ireland geography tokens for English-pinned Google News templates.',
    keys: ['ukGeo', 'ukGeoTight'],
  },
  {
    rel: 'data/discovery/region/region-nordic.json',
    _docs: 'Nordic cult stems + geography for Nordic-pinned Google News rows.',
    keys: ['nordicSearchCultOr', 'nordicsGeo'],
  },
  {
    rel: 'data/discovery/region/region-cz-sk.json',
    _docs: 'Czechia and Slovakia cult stems + geography for cs/sk-pinned Google News rows.',
    keys: ['czSkCultOr', 'czGeo'],
  },
  {
    rel: 'data/discovery/region/region-balkans.json',
    _docs: 'Western Balkans cult stems + geography for Balkan-pinned Google News rows.',
    keys: ['balkansCultOr', 'balkansGeo'],
  },
  {
    rel: 'data/discovery/region/region-baltics.json',
    _docs: 'Baltic cult stems + geography for Baltic-pinned Google News rows.',
    keys: ['balticsCultOr', 'balticsGeo'],
  },
  {
    rel: 'data/discovery/region/region-microstates.json',
    _docs: 'European microstates cult morphology + geography.',
    keys: ['microstatesCultOr', 'microstatesGeo'],
  },
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
  for (const r of REGION_FILES) {
    for (const k of r.keys) {
      assigned.add(k);
    }
  }
  for (const keys of Object.values(LANG_GROUP_KEYS)) {
    for (const k of keys) {
      assigned.add(k);
    }
  }

  for (const k of Object.keys(groups)) {
    if (!assigned.has(k)) {
      throw new Error(`Group "${k}" is not listed in CORE_KEYS, REGION_FILES, or LANG_GROUP_KEYS — add it to the split script.`);
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
  mkdirSync(join(root, 'data/discovery/region'), { recursive: true });

  const corePayload = {
    _docs:
      'Minimal shared Latin cult/sect stems for Google News q= templates. Continental and sub-regional geo live in data/discovery/region/*.json; language-specific tokens in data/discovery/lang/*.json.',
    groups: pick(CORE_KEYS),
  };
  writeFileSync(join(root, 'data/discovery/groups-core.json'), `${JSON.stringify(corePayload, null, 2)}\n`);

  for (const r of REGION_FILES) {
    const regionPayload = {
      _docs: r._docs,
      groups: pick(r.keys),
    };
    const outPath = join(root, r.rel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(regionPayload, null, 2)}\n`);
  }

  const langCodes = Object.keys(LANG_GROUP_KEYS).sort();
  for (const lang of langCodes) {
    const payload = {
      _docs: `Language-specific Google News query groups for "${lang}" (cult-related + Europe country OR list).`,
      language: lang,
      groups: pick(LANG_GROUP_KEYS[lang]),
    };
    writeFileSync(join(root, `data/discovery/lang/${lang}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  }

  const groupFiles = [
    'data/discovery/groups-core.json',
    ...REGION_FILES.map((r) => r.rel),
    ...langCodes.map((l) => `data/discovery/lang/${l}.json`),
  ];

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
