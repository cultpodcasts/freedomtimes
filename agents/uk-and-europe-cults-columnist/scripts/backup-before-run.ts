#!/usr/bin/env tsx
/**
 * Creates timestamped backups of working files before pipeline runs.
 * Usage: npx tsx scripts/backup-before-run.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, '..');

const FILES_TO_BACKUP = [
  'pipeline-run.log',
  'pipeline-run-dry.log',
  'reports/drafts-archive.json',
  'reports/last-run-drafts.json',
  'reports/cult-news-latest.html',
  'data/feedback/false-positives.json',
];

function getTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function backupFile(filePath: string): void {
  const fullPath = path.join(AGENT_DIR, filePath);
  
  if (!fs.existsSync(fullPath)) {
    console.log(`[backup] Skipping (not found): ${filePath}`);
    return;
  }

  const timestamp = getTimestamp();
  const ext = path.extname(filePath);
  const basename = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  const backupName = `${basename}.${timestamp}${ext}`;
  const backupPath = path.join(AGENT_DIR, dir, 'backups', backupName);

  // Ensure backups directory exists
  const backupDir = path.dirname(backupPath);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  fs.copyFileSync(fullPath, backupPath);
  console.log(`[backup] Backed up: ${filePath} -> ${backupName}`);
}

function main(): void {
  console.log(`[backup] Starting backup at ${new Date().toISOString()}`);
  
  for (const file of FILES_TO_BACKUP) {
    try {
      backupFile(file);
    } catch (error) {
      console.error(`[backup] Failed to backup ${file}:`, error);
      process.exit(1);
    }
  }
  
  console.log(`[backup] Backup complete`);
}

main();
