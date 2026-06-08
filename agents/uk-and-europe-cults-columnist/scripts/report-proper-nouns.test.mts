import { extractReportProperNouns } from '../src/reportProperNouns.ts';

const bbcLead =
  'Skipper admits failure to provide food and rest for foreign seamen. Tom Nicholson Jr pled guilty at Hamilton Sheriff Court. Workers from Ghana said they were treated like slaves aboard the Sea Lady.';

const hoytLead =
  'Bring Me the Beauties: A Model Cult charts supermodel Hoyt Richards and the Eternal Values cult led by Frederick von Mierers in New York.';

const navPolluted =
  'Site Menu News Reviews Interviews BRING ME THE BEAUTIES: A MODEL CULT Review. Directed by Chris Smith, Hoyt Richards met Frederick von Mierers on Nantucket beach.';

function assertIncludes(terms: string[], phrase: string, label: string): void {
  if (!terms.some((t) => t.includes(phrase.toLowerCase()))) {
    throw new Error(`${label}: expected to include "${phrase}", got ${JSON.stringify(terms.slice(0, 12))}`);
  }
}

function assertExcludes(terms: string[], phrase: string, label: string): void {
  if (terms.some((t) => t.includes(phrase.toLowerCase()))) {
    throw new Error(`${label}: should not include "${phrase}", got ${JSON.stringify(terms)}`);
  }
}

const bbc = extractReportProperNouns(bbcLead);
assertIncludes(bbc, 'nicholson', 'bbc');
assertExcludes(bbc, 'workers from ghana', 'bbc');
assertIncludes(bbc, 'hamilton sheriff', 'bbc');
assertIncludes(bbc, 'sea lady', 'bbc');
assertExcludes(bbc, 'share save', 'bbc');
assertExcludes(bbc, 'like slaves', 'bbc');

const hoyt = extractReportProperNouns(hoytLead);
assertIncludes(hoyt, 'hoyt richards', 'hoyt');
assertIncludes(hoyt, 'frederick', 'hoyt');
assertIncludes(hoyt, 'eternal values', 'hoyt');
assertExcludes(hoyt, 'bring me', 'hoyt');

const nav = extractReportProperNouns(navPolluted);
assertExcludes(nav, 'site menu', 'nav');
assertIncludes(nav, 'hoyt richards', 'nav');

console.log('[report-proper-nouns] 3 cases passed');
