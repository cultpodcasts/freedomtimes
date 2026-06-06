/**
 * Build data/discovery/cluster-modifiers/<locale>.json from Kaikki JSONL + manual seeds.
 *
 * Kaikki dump is ~2.6GB gzip — cached under data/discovery/_cache/ (gitignored).
 *
 *   npx tsx scripts/build-cluster-modifier-terms.mts --download
 *   npx tsx scripts/build-cluster-modifier-terms.mts --input data/discovery/_cache/raw-wiktextract-data.jsonl.gz
 *   npx tsx scripts/build-cluster-modifier-terms.mts --seeds-only
 *   npx tsx scripts/build-cluster-modifier-terms.mts --strip-lang-fields
 *
 * Committed output: data/discovery/cluster-modifiers/*.json (not lang/*.json).
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { get as httpGet } from 'node:https';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_TERMS_PER_LOCALE,
  DISCOVERY_LOCALE_TO_KAIKKI_LANG,
  KAIKKI_RAW_JSONL_GZ_URL,
  discoveryLocales,
} from '../src/kaikkiClusterModifierConfig.ts';
import {
  capModifierTerms,
  lemmasFromKaikkiEntry,
  mergeModifierTermLists,
  type KaikkiEntry,
} from '../src/kaikkiClusterModifierExtract.ts';

const ROOT = new URL('../', import.meta.url);
const MODIFIERS_DIR = new URL('data/discovery/cluster-modifiers/', ROOT);
const CACHE_DIR = new URL('data/discovery/_cache/', ROOT);
const SEEDS_PATH = new URL('data/discovery/cluster-modifier-seeds.json', ROOT);
const LANG_DIR = new URL('data/discovery/lang/', ROOT);
const DEFAULT_CACHE_FILE = fileURLToPath(new URL('raw-wiktextract-data.jsonl.gz', CACHE_DIR));

type ModifierFile = {
  language: string;
  sources: string[];
  generatedAt: string;
  kaikkiInput?: string;
  maxTermsPerLocale: number;
  termCount: number;
  terms: string[];
};

function parseArgs(argv: string[]): {
  download: boolean;
  seedsOnly: boolean;
  stripLangFields: boolean;
  inputPath?: string;
  maxTerms: number;
  maxLines?: number;
} {
  let download = false;
  let seedsOnly = false;
  let stripLangFields = false;
  let inputPath: string | undefined;
  let maxTerms = DEFAULT_MAX_TERMS_PER_LOCALE;
  let maxLines: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--download') download = true;
    else if (arg === '--seeds-only') seedsOnly = true;
    else if (arg === '--strip-lang-fields') stripLangFields = true;
    else if (arg === '--input') inputPath = argv[++i];
    else if (arg === '--max-terms') maxTerms = Number(argv[++i]);
    else if (arg === '--max-lines') maxLines = Number(argv[++i]);
  }

  return { download, seedsOnly, stripLangFields, inputPath, maxTerms, maxLines };
}

function loadSeeds(): Record<string, string[]> {
  if (!existsSync(SEEDS_PATH)) return {};
  const parsed = JSON.parse(readFileSync(SEEDS_PATH, 'utf-8')) as {
    locales?: Record<string, unknown>;
  };
  const result: Record<string, string[]> = {};
  for (const [lang, terms] of Object.entries(parsed.locales ?? {})) {
    if (!Array.isArray(terms)) continue;
    result[lang.toLowerCase()] = terms.filter((t) => typeof t === 'string') as string[];
  }
  return result;
}

async function downloadKaikki(targetPath: string): Promise<void> {
  mkdirSync(fileURLToPath(CACHE_DIR), { recursive: true });
  console.log(`[build-cluster-modifier-terms] downloading ${KAIKKI_RAW_JSONL_GZ_URL}`);
  console.log(`[build-cluster-modifier-terms] → ${targetPath}`);

  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(targetPath);
    httpGet(KAIKKI_RAW_JSONL_GZ_URL, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Kaikki download failed: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function extractFromKaikki(
  inputPath: string,
  targetKaikkiLangs: Set<string>,
  maxLines?: number,
): Promise<Map<string, Set<string>>> {
  const byLang = new Map<string, Set<string>>();
  for (const lang of targetKaikkiLangs) {
    byLang.set(lang, new Set());
  }

  const input = createReadStream(inputPath);
  const stream = inputPath.endsWith('.gz') ? input.pipe(createGunzip()) : input;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lines = 0;
  let matched = 0;

  for await (const line of rl) {
    lines += 1;
    if (maxLines !== undefined && lines > maxLines) break;
    if (!line.trim()) continue;

    let entry: KaikkiEntry;
    try {
      entry = JSON.parse(line) as KaikkiEntry;
    } catch {
      continue;
    }

    const langCode = typeof entry.lang_code === 'string' ? entry.lang_code.toLowerCase() : '';
    if (!targetKaikkiLangs.has(langCode)) continue;

    const lemmas = lemmasFromKaikkiEntry(entry);
    if (lemmas.length === 0) continue;

    const set = byLang.get(langCode)!;
    for (const lemma of lemmas) {
      set.add(lemma.toLowerCase());
    }
    matched += 1;

    if (lines % 500_000 === 0) {
      console.log(`[build-cluster-modifier-terms] scanned ${lines.toLocaleString()} lines (${matched.toLocaleString()} modifier entries)`);
    }
  }

  console.log(
    `[build-cluster-modifier-terms] finished scan: ${lines.toLocaleString()} lines, ${matched.toLocaleString()} modifier entries`,
  );
  return byLang;
}

function writeModifierFile(locale: string, payload: ModifierFile): void {
  mkdirSync(fileURLToPath(MODIFIERS_DIR), { recursive: true });
  const path = new URL(`${locale}.json`, MODIFIERS_DIR);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function stripClusterModifierTermsFromLangFiles(): void {
  for (const name of readdirSync(LANG_DIR).filter((n) => n.endsWith('.json'))) {
    const fileUrl = new URL(name, LANG_DIR);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf-8')) as Record<string, unknown>;
    if (!('clusterModifierTerms' in parsed)) continue;
    delete parsed.clusterModifierTerms;
    writeFileSync(fileUrl, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    console.log(`[build-cluster-modifier-terms] stripped clusterModifierTerms from lang/${name}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seeds = loadSeeds();
  const generatedAt = new Date().toISOString();

  if (args.stripLangFields) {
    stripClusterModifierTermsFromLangFiles();
  }

  let kaikkiByLang = new Map<string, Set<string>>();
  let kaikkiInput: string | undefined;

  if (!args.seedsOnly) {
    mkdirSync(fileURLToPath(CACHE_DIR), { recursive: true });
    const cachePath = args.inputPath ?? DEFAULT_CACHE_FILE;

    if (args.download) {
      await downloadKaikki(cachePath);
    }

    if (!existsSync(cachePath)) {
      console.error(
        `[build-cluster-modifier-terms] missing Kaikki input: ${cachePath}\n` +
          '  Run with --download, --input <path>, or --seeds-only for manual supplements only.',
      );
      process.exitCode = 1;
      return;
    }

    kaikkiInput = cachePath;
    const targetKaikkiLangs = new Set(Object.values(DISCOVERY_LOCALE_TO_KAIKKI_LANG));
    kaikkiByLang = await extractFromKaikki(cachePath, targetKaikkiLangs, args.maxLines);
  }

  mkdirSync(fileURLToPath(MODIFIERS_DIR), { recursive: true });
  let totalTerms = 0;
  let totalBytes = 0;

  for (const locale of discoveryLocales()) {
    const kaikkiLang = DISCOVERY_LOCALE_TO_KAIKKI_LANG[locale]!;
    const kaikkiTerms = kaikkiByLang.get(kaikkiLang) ?? new Set<string>();
    const capped = capModifierTerms(kaikkiTerms, args.maxTerms);
    const terms = mergeModifierTermLists(capped, seeds[locale] ?? []);

    const sources: string[] = [];
    if (kaikkiTerms.size > 0) sources.push('kaikki:raw-wiktextract-data');
    if ((seeds[locale] ?? []).length > 0) sources.push('cluster-modifier-seeds.json');
    if (sources.length === 0) sources.push('empty');

    const payload: ModifierFile = {
      language: locale,
      sources,
      generatedAt,
      maxTermsPerLocale: args.maxTerms,
      termCount: terms.length,
      terms,
    };
    if (kaikkiInput) payload.kaikkiInput = kaikkiInput;

    writeModifierFile(locale, payload);
    const bytes = readFileSync(fileURLToPath(new URL(`${locale}.json`, MODIFIERS_DIR))).length;
    totalTerms += terms.length;
    totalBytes += bytes;
    console.log(
      `[build-cluster-modifier-terms] ${locale}: ${terms.length} terms (${(bytes / 1024).toFixed(1)} KB, kaikki=${kaikkiTerms.size}, seeds=${(seeds[locale] ?? []).length})`,
    );
  }

  const manifest = {
    generatedAt,
    kaikkiInput: kaikkiInput ?? null,
    maxTermsPerLocale: args.maxTerms,
    localeCount: discoveryLocales().length,
    totalTerms,
    totalBytes,
  };
  writeFileSync(
    fileURLToPath(new URL('_manifest.json', MODIFIERS_DIR)),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  );

  console.log(
    `[build-cluster-modifier-terms] wrote ${discoveryLocales().length} files, ${totalTerms.toLocaleString()} terms, ${(totalBytes / 1024 / 1024).toFixed(2)} MB total`,
  );
}

main().catch((err) => {
  console.error('[build-cluster-modifier-terms]', err);
  process.exitCode = 1;
});
