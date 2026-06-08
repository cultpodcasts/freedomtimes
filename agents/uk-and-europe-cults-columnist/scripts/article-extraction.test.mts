import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { htmlToPlainArticleText } from '../src/articleContent.ts';

type FixtureEntry = {
  html: string;
  mustInclude: string[];
  mustExclude: string[];
};

const FIXTURE_PATH = new URL('../tests/fixtures/article-extraction-snippets.json', import.meta.url);
const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, FixtureEntry>;

let failures = 0;

for (const [name, fixture] of Object.entries(fixtures)) {
  const text = htmlToPlainArticleText(fixture.html, 4000);
  for (const phrase of fixture.mustInclude) {
    if (!text.includes(phrase)) {
      console.error(`[article-extraction] ${name}: missing "${phrase}"\n  got: ${text.slice(0, 200)}`);
      failures += 1;
    }
  }
  for (const phrase of fixture.mustExclude) {
    if (text.includes(phrase)) {
      console.error(`[article-extraction] ${name}: should not include "${phrase}"\n  got: ${text.slice(0, 200)}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`[article-extraction] ${failures} assertion(s) failed`);
  process.exit(1);
}

console.log(`[article-extraction] ${Object.keys(fixtures).length} fixtures passed`);
