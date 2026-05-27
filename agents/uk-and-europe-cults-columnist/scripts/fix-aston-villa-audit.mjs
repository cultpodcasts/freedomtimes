#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { isCultTopicPreciseWithAudit } from '../src/pipeline.js';

async function fixAstonVilla() {
  const archive = JSON.parse(await readFile('reports/drafts-archive.json', 'utf-8'));
  
  const entry = archive.find(e => e.url.includes('aston-villa'));
  if (!entry) {
    console.log('Entry not found');
    return;
  }

  console.log('Found:', entry.draft.title);
  
  if (entry.draft.classificationAudit) {
    console.log('Already has audit:', JSON.stringify(entry.draft.classificationAudit, null, 2));
    return;
  }

  // Generate audit
  const result = isCultTopicPreciseWithAudit(
    entry.draft.title,
    entry.draft.body,
    entry.url,
    'en'
  );

  entry.draft.classificationAudit = result.audit;
  
  await writeFile('reports/drafts-archive.json', JSON.stringify(archive, null, 2));
  console.log('Audit added!');
  console.log(JSON.stringify(result.audit, null, 2));
}

fixAstonVilla().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
