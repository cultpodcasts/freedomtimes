/**
 * Normalize europeCountryOr in every locale lang file:
 * - en.json unchanged
 * - strip English discovery terms from non-en locales
 * - add missing localized names (de UK block, mt full list, UK subdivisions)
 *
 *   npx tsx scripts/apply-localized-europe-country-or.mts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripDiscoveryCountryTerm } from '../src/discoveryLangEuropeCountries.ts';

const LANG_DIR = new URL('../data/discovery/lang/', import.meta.url);

/** English forms that must appear only in en.json (not exhaustive internationals like Portugal). */
const ENGLISH_ONLY = new Set([
  'europe',
  'uk',
  'united kingdom',
  'britain',
  'england',
  'scotland',
  'wales',
  'northern ireland',
  'france',
  'germany',
  'spain',
  'italy',
  'netherlands',
  'poland',
  'greece',
  'belgium',
  'sweden',
  'norway',
  'denmark',
  'finland',
  'switzerland',
  'czech republic',
  'croatia',
  'north macedonia',
  'cyprus',
  'ireland',
]);

function termKey(term: string): string {
  return stripDiscoveryCountryTerm(term).toLowerCase();
}

/** Extra localized terms to merge when absent. */
const SUPPLEMENTS: Record<string, string[]> = {
  de: [
    'Vereinigtes Königreich',
    'Großbritannien',
    'England',
    'Schottland',
    'Wales',
    'Nordirland',
    'Polen',
    'Rumänien',
    'Portugal',
    'Griechenland',
    'Estland',
    'Lettland',
    'Litauen',
    'Zypern',
  ],
  mt: [
    'Ewropa',
    'Renju Unit',
    'Gran Brittanja',
    'Ingilterra',
    'Skozja',
    'Galles',
    "Irlanda ta' Fuq",
    'Irlanda',
    'Franza',
    'Ġermanja',
    'Spanja',
    'Talja',
    'Olanda',
    'Polonja',
    'Rumanija',
    'Portugall',
    'Greċja',
    'Belġju',
    'Żvezja',
    'Norveġja',
    'Dinamarca',
    'Awstrija',
    'Finlandja',
    'Svizzera',
    'Repubblika Ċeka',
    'Kroazja',
    'Serbja',
    'Slovenja',
    'Bożnija',
    'Montenegro',
    "Maċedonia ta' Fuq",
    'Kosovo',
    'Albanija',
    'Estonja',
    'Latvja',
    'Litwanja',
    'Malta',
    'Lussemburgu',
    'Monako',
    'San Marino',
    'Liechtenstein',
    'Andorra',
    'Vatikan',
    'Ċipru',
  ],
  pl: ['Anglia', 'Szkocja', 'Walia', 'Irlandia Północna'],
  es: ['Inglaterra', 'Escocia', 'Gales', 'Irlanda del Norte'],
  pt: ['Inglaterra', 'Escócia', 'País de Gales', 'Irlanda do Norte'],
  cs: ['Anglie', 'Skotsko', 'Wales', 'Severní Irsko'],
  sk: ['Anglicko', 'Skótsko', 'Wales', 'Severné Írsko'],
  nl: ['Engeland', 'Schotland', 'Wales', 'Noord-Ierland'],
  da: ['England', 'Skotland', 'Wales', 'Nordirland'],
  sv: ['England', 'Skottland', 'Wales', 'Nordirland'],
  no: ['England', 'Skottland', 'Wales', 'Nord-Irland'],
  fi: ['Englanti', 'Skotlanti', 'Wales', 'Pohjois-Irlanti'],
  el: ['Αγγλία', 'Σκωτία', 'Ουαλία', 'Βόρεια Ιρλανδία'],
  hu: ['Belgium', 'Anglia', 'Skócia', 'Wales', 'Észak-Írország'],
  ro: ['Anglia', 'Scoția', 'Țara Galilor', 'Irlanda de Nord'],
  bg: ['Англия', 'Шотландия', 'Уелс', 'Северна Ирландия'],
  hr: ['Engleska', 'Škotska', 'Wales', 'Sjeverna Irska'],
  sl: ['Anglija', 'Škotska', 'Wales', 'Severna Irska'],
  bs: ['Engleska', 'Škotska', 'Wales', 'Sjeverna Irska'],
  sr: ['Engleska', 'Škotska', 'Wels', 'Severna Irska'],
  mk: ['Англија', 'Шкотска', 'Велс', 'Северна Ирландија'],
  uk: ['Англія', 'Шотландія', 'Уельс', 'Північна Ірландія'],
  sq: ['Anglia', 'Skocia', 'Uells', 'Irlanda e Veriut'],
  is: ['England', 'Skotland', 'Wales', 'Norður-Írland'],
  et: ['Inglismaa', 'Šotimaa', 'Wales', 'Põhja-Iirimaa'],
  lt: ['Anglija', 'Škotija', 'Velsas', 'Šiaurės Airija'],
  lv: ['Anglija', 'Skotija', 'Velsa', 'Ziemeļīrija'],
  it: [], // already complete
  fr: [], // already complete
};

function mergeTerms(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing.map(termKey));
  const merged = [...existing];
  for (const term of additions) {
    const key = termKey(term);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(term);
  }
  return merged;
}

function stripEnglishLeaks(terms: string[]): string[] {
  return terms.filter((term) => !ENGLISH_ONLY.has(termKey(term)));
}

function main(): void {
  const names = readdirSync(LANG_DIR).filter((n) => n.endsWith('.json')).sort();
  for (const name of names) {
    const lang = name.replace(/\.json$/i, '');
    if (lang === 'en') continue;

    const fileUrl = new URL(name, LANG_DIR);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf-8')) as Record<string, unknown>;
    const before = Array.isArray(parsed.europeCountryOr) ? (parsed.europeCountryOr as string[]) : [];
    const stripped = stripEnglishLeaks(before);
    const after = mergeTerms(stripped, SUPPLEMENTS[lang] ?? []);
    parsed.europeCountryOr = after;
    writeFileSync(fileUrl, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    console.log(`[apply-localized-country-or] ${lang}: ${before.length} → ${after.length} terms`);
  }
}

main();
