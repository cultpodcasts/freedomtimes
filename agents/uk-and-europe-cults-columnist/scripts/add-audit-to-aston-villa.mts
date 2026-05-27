#!/usr/bin/env node
/**
 * Add classification audit to the Aston Villa story
 */
import { readFile, writeFile } from 'fs/promises';
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

async function addAuditToAstonVilla() {
  const archivePath = 'reports/drafts-archive.json';
  const archive: DraftArchiveEntry[] = JSON.parse(
    await readFile(archivePath, 'utf-8')
  );

  const targetUrl = 'https://observer.co.uk/news/sport/article/aston-villa-and-crystal-palace-are-they-the-baddies';
  const entry = archive.find(e => e.url === targetUrl);

  if (!entry) {
    console.log('Aston Villa entry not found');
    return;
  }

  if (entry.draft.classificationAudit) {
    console.log('Already has audit data');
    console.log(JSON.stringify(entry.draft.classificationAudit, null, 2));
    return;
  }

  const title = entry.draft.title || '';
  const body = entry.draft.body || '';
  const url = entry.url;

  const result = isCultTopicPreciseWithAudit(title, body, url, 'en');
  entry.draft.classificationAudit = result.audit;

  await writeFile(archivePath, JSON.stringify(archive, null, 2));
  console.log('Audit added successfully!');
  console.log(JSON.stringify(result.audit, null, 2));
}

addAuditToAstonVilla().catch(console.error);
