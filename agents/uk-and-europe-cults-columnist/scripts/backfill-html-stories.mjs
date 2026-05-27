#!/usr/bin/env node
/**
 * Backfill classification audit for all stories in cult-news-latest.html
 */
import { readFile, writeFile } from 'fs/promises';
import { isCultTopicPreciseWithAudit } from '../src/pipeline.js';

async function backfillHtmlStories() {
  // Read the HTML to extract story URLs
  const html = await readFile('reports/cult-news-latest.html', 'utf-8');
  
  // Extract URLs from data-url attributes
  const urlMatches = html.match(/data-url="([^"]+)"/g) || [];
  const urls = urlMatches.map(m => m.replace('data-url="', '').replace('"', ''));
  
  console.log(`Found ${urls.length} stories in HTML report`);
  
  // Read archive
  const archivePath = 'reports/drafts-archive.json';
  const archive = JSON.parse(await readFile(archivePath, 'utf-8'));
  
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const url of urls) {
    const entry = archive.find(e => e.url === url);
    if (!entry) {
      console.log(`  Not found in archive: ${url}`);
      errors++;
      continue;
    }
    
    // Skip if already has audit
    if (entry.draft?.classificationAudit) {
      skipped++;
      continue;
    }
    
    try {
      const title = entry.draft?.title || '';
      const body = entry.draft?.body || '';
      
      // Detect language from URL
      let language = 'en';
      if (/\.(fr|lemonde|leparisien|liberation)\./.test(url)) language = 'fr';
      else if (/\.(de|spiegel|zeit|faz)\./.test(url)) language = 'de';
      else if (/\.(it|corriere|repubblica)\./.test(url)) language = 'it';
      else if (/\.(es|elpais|elmundo)\./.test(url)) language = 'es';
      else if (/\.(pt|publico|dn)\./.test(url)) language = 'pt';
      else if (/\.(ro|hotnews)\./.test(url)) language = 'ro';
      
      // Generate audit
      const result = isCultTopicPreciseWithAudit(title, body, url, language);
      
      // Add to entry
      if (!entry.draft) entry.draft = {};
      entry.draft.classificationAudit = result.audit;
      
      updated++;
      if (updated % 10 === 0) {
        console.log(`  Processed ${updated} entries...`);
      }
    } catch (err) {
      console.error(`  Error processing ${url}:`, err.message);
      errors++;
    }
  }
  
  // Save updated archive
  await writeFile(archivePath, JSON.stringify(archive, null, 2));
  
  console.log('\nBackfill complete:');
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (already had audit): ${skipped}`);
  console.log(`  Not found in archive: ${errors}`);
  
  // Re-render HTML
  console.log('\nRe-rendering HTML report...');
  const { execSync } = await import('child_process');
  execSync('npx tsx scripts/render-cult-news-html.tsx', { stdio: 'inherit' });
  console.log('Done!');
}

backfillHtmlStories().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
