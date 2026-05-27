#!/usr/bin/env node
/**
 * Backfill classification audit data for existing archived drafts
 * that don't have classificationAudit populated.
 */
import { readFile, writeFile } from 'fs/promises';
// Import directly from pipeline to avoid triggering discoverStories
import { isCultTopicPreciseWithAudit } from '../src/pipeline.js';

interface DraftArchiveEntry {
  url: string;
  firstSeenAt: string;
  draft: {
    title: string;
    dek?: string;
    body?: string;
    classificationAudit?: unknown;
    source?: {
      url?: string;
      host?: string;
    };
  };
}

async function backfillAuditData() {
  const archivePath = 'reports/drafts-archive.json';
  const archive: DraftArchiveEntry[] = JSON.parse(
    await readFile(archivePath, 'utf-8')
  );

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of archive) {
    // Skip if already has audit data
    if (entry.draft.classificationAudit) {
      skipped++;
      continue;
    }

    try {
      const title = entry.draft.title || '';
      const body = entry.draft.body || '';
      const url = entry.url || '';
      
      // Determine language from URL/host
      let language = 'en';
      const host = entry.draft.source?.host || '';
      if (/\.(fr|lemonde|leparisien|liberation)\./.test(host)) language = 'fr';
      else if (/\.(de|spiegel|zeit|faz)\./.test(host)) language = 'de';
      else if (/\.(it|corriere|repubblica|ilmessaggero)\./.test(host)) language = 'it';
      else if (/\.(es|elpais|elmundo|abc)\./.test(host)) language = 'es';
      else if (/\.(pt|publico|dn)\./.test(host)) language = 'pt';
      else if (/\.(ro|hotnews|adevarul)\./.test(host)) language = 'ro';

      // Re-run classification with audit
      const result = isCultTopicPreciseWithAudit(title, body, url, language);
      
      // Add audit data to the draft
      entry.draft.classificationAudit = result.audit;
      updated++;
      
      if (updated % 10 === 0) {
        console.log(`Processed ${updated} entries...`);
      }
    } catch (err) {
      console.error(`Error processing ${entry.url}:`, err);
      errors++;
    }
  }

  // Save updated archive
  await writeFile(archivePath, JSON.stringify(archive, null, 2));
  
  console.log('\nBackfill complete:');
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (already had audit): ${skipped}`);
  console.log(`  Errors: ${errors}`);
}

backfillAuditData().catch(console.error);
