import { readFileSync } from 'fs';

const archive = JSON.parse(readFileSync('reports/drafts-archive.json', 'utf-8'));
const entry = archive.find(e => e.url.includes('aston-villa'));

if (!entry) {
  console.log('Entry not found');
  process.exit(1);
}

console.log('URL:', entry.url);
console.log('Has draft:', !!entry.draft);
console.log('Has classificationAudit:', !!entry.draft?.classificationAudit);

if (entry.draft?.classificationAudit) {
  console.log('Audit data:', JSON.stringify(entry.draft.classificationAudit, null, 2));
} else {
  console.log('Draft keys:', Object.keys(entry.draft || {}));
}
