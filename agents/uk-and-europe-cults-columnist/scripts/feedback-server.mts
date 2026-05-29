#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number.parseInt(process.env.FEEDBACK_SERVER_PORT || '3000', 10);
const REPORTS_DIR = join(__dirname, '../reports');
const DATA_DIR = join(__dirname, '../data');
const FEEDBACK_DIR = join(DATA_DIR, 'feedback');
const FEEDBACK_FILE = join(FEEDBACK_DIR, 'active-report.json');
const ARCHIVED_FEEDBACK_DIR = join(FEEDBACK_DIR, 'archived');
const TRAINING_DATA_FILE = join(DATA_DIR, 'training-data.jsonl');

type FeedbackEntry = {
  url: string;
  title?: string;
  reason: 'false-positive' | 'wrong-cluster' | 'verified';
  flaggedAt: string;
  clusterId?: string;
  verifiedAt?: string;
  articleText?: string;
  classificationAudit?: unknown;
};

type ActiveReport = {
  reportId: string;
  createdAt: string;
  status: 'review' | 'verification' | 'closed';
  entries: FeedbackEntry[];
};

function ensureDirectories(): void {
  if (!existsSync(FEEDBACK_DIR)) {
    mkdirSync(FEEDBACK_DIR, { recursive: true });
  }
  if (!existsSync(ARCHIVED_FEEDBACK_DIR)) {
    mkdirSync(ARCHIVED_FEEDBACK_DIR, { recursive: true });
  }
}

function loadActiveReport(): ActiveReport | null {
  if (!existsSync(FEEDBACK_FILE)) {
    return null;
  }
  try {
    const content = readFileSync(FEEDBACK_FILE, 'utf-8');
    return JSON.parse(content) as ActiveReport;
  } catch {
    return null;
  }
}

function saveActiveReport(report: ActiveReport): void {
  writeFileSync(FEEDBACK_FILE, JSON.stringify(report, null, 2), 'utf-8');
}

function archiveReport(report: ActiveReport): void {
  const archivePath = join(ARCHIVED_FEEDBACK_DIR, `${report.reportId}.json`);
  writeFileSync(archivePath, JSON.stringify(report, null, 2), 'utf-8');
}

function appendToTrainingData(entry: FeedbackEntry): void {
  const line = JSON.stringify(entry);
  writeFileSync(TRAINING_DATA_FILE, line + '\n', { flag: 'a' });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { error: message }, status);
}

function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const corsHeaders = getCorsHeaders();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const path = url.pathname;

  // Serve the rendered HTML report
  if (path === '/' || path === '/index.html') {
    const reportPath = join(REPORTS_DIR, 'cult-news-latest.html');
    if (!existsSync(reportPath)) {
      res.writeHead(404, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end('Report not found. Run: npm run render:html');
      return;
    }
    const html = readFileSync(reportPath, 'utf-8');
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // API: Get active report status
  if (path === '/api/report/status' && req.method === 'GET') {
    const report = loadActiveReport();
    if (!report) {
      sendJson(res, { status: 'none' });
      return;
    }
    sendJson(res, {
      reportId: report.reportId,
      status: report.status,
      createdAt: report.createdAt,
      entryCount: report.entries.length,
    });
    return;
  }

  // API: Initialize new report
  if (path === '/api/report/init' && req.method === 'POST') {
    ensureDirectories();
    const reportId = new Date().toISOString().replace(/[:.]/g, '-');
    const report: ActiveReport = {
      reportId,
      createdAt: new Date().toISOString(),
      status: 'review',
      entries: [],
    };
    saveActiveReport(report);
    sendJson(res, { reportId, status: 'review' });
    return;
  }

  // API: Mark story as false-positive
  if (path === '/api/feedback/false-positive' && req.method === 'POST') {
    const report = loadActiveReport();
    if (!report) {
      sendError(res, 'No active report. Initialize a report first.', 400);
      return;
    }
    if (report.status !== 'review') {
      sendError(res, 'Report is not in review status', 400);
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }
    const data = JSON.parse(body) as { url: string; title?: string; articleText?: string; classificationAudit?: unknown };

    if (!data.url) {
      sendError(res, 'url is required');
      return;
    }

    // Remove existing entry if present (undo)
    report.entries = report.entries.filter((e) => e.url !== data.url);

    // Add new entry
    report.entries.push({
      url: data.url,
      title: data.title,
      reason: 'false-positive',
      flaggedAt: new Date().toISOString(),
      articleText: data.articleText,
      classificationAudit: data.classificationAudit,
    });

    saveActiveReport(report);
    sendJson(res, { success: true, entryCount: report.entries.length });
    return;
  }

  // API: Unmark story (remove feedback)
  if (path === '/api/feedback/unmark' && req.method === 'POST') {
    const report = loadActiveReport();
    if (!report) {
      sendError(res, 'No active report', 404);
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }
    const data = JSON.parse(body) as { url: string };

    if (!data.url) {
      sendError(res, 'url is required');
      return;
    }

    const beforeCount = report.entries.length;
    report.entries = report.entries.filter((e) => e.url !== data.url);
    const removed = beforeCount - report.entries.length;

    saveActiveReport(report);
    sendJson(res, { success: true, removed, entryCount: report.entries.length });
    return;
  }

  // API: Get all feedback entries
  if (path === '/api/feedback' && req.method === 'GET') {
    const report = loadActiveReport();
    if (!report) {
      sendJson(res, { entries: [] });
      return;
    }
    sendJson(res, { entries: report.entries });
    return;
  }

  // API: Close report (transition to verification)
  if (path === '/api/report/close' && req.method === 'POST') {
    const report = loadActiveReport();
    if (!report) {
      sendError(res, 'No active report', 404);
      return;
    }

    // Write false-positives to the file the render script reads
    const falsePosPath = join(FEEDBACK_DIR, 'false-positives.json');
    console.log('[feedback-server] writing false-positives to:', falsePosPath);
    const existingFP = existsSync(falsePosPath)
      ? (JSON.parse(readFileSync(falsePosPath, 'utf-8')) as { entries: FeedbackEntry[] })
      : { entries: [] };
    const newFPUrls = new Set(report.entries.filter((e) => e.reason === 'false-positive').map((e) => e.url));
    const merged = [
      ...existingFP.entries.filter((e) => !newFPUrls.has(e.url)),
      ...report.entries.filter((e) => e.reason === 'false-positive'),
    ];
    try {
      writeFileSync(falsePosPath, JSON.stringify({ entries: merged }, null, 2), 'utf-8');
      console.log('[feedback-server] wrote', merged.length, 'false-positives to', falsePosPath);
    } catch (writeErr) {
      console.error('[feedback-server] failed to write false-positives:', writeErr);
      sendError(res, 'Failed to write false-positives: ' + String(writeErr), 500);
      return;
    }

    // Re-render HTML so clustering excludes the false-positives.
    // Inherit CULT_NEWS_RENDER_MAX_AGE_HOURS from the server process (set it when
    // starting feedback:server, or in .env). Never force a narrower window here.
    const renderMaxAge = process.env.CULT_NEWS_RENDER_MAX_AGE_HOURS?.trim() || '(unset)';
    console.log('[feedback-server] re-rendering digest; CULT_NEWS_RENDER_MAX_AGE_HOURS =', renderMaxAge);
    try {
      execSync('npx tsx --env-file=.env scripts/render-cult-news-html.tsx', {
        cwd: join(__dirname, '..'),
        env: process.env,
        stdio: 'inherit',
      });
    } catch (err) {
      console.error('[feedback-server] render failed:', err);
    }

    report.status = 'verification';
    saveActiveReport(report);
    sendJson(res, { success: true, status: 'verification' });
    return;
  }

  // API: Verify cluster
  if (path === '/api/cluster/verify' && req.method === 'POST') {
    const report = loadActiveReport();
    if (!report) {
      sendError(res, 'No active report', 404);
      return;
    }
    if (report.status !== 'verification') {
      sendError(res, 'Report is not in verification status', 400);
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }
    const data = JSON.parse(body) as { clusterId: string; verified: boolean };

    if (!data.clusterId) {
      sendError(res, 'clusterId is required');
      return;
    }

    // Update entries in this cluster
    report.entries.forEach((entry) => {
      if (entry.clusterId === data.clusterId) {
        entry.reason = data.verified ? 'verified' : 'wrong-cluster';
        entry.verifiedAt = new Date().toISOString();
      }
    });

    saveActiveReport(report);
    sendJson(res, { success: true });
    return;
  }

  // API: Finalize report (archive and export training data)
  if (path === '/api/report/finalize' && req.method === 'POST') {
    const report = loadActiveReport();
    if (!report) {
      sendError(res, 'No active report', 404);
      return;
    }

    // Archive report
    archiveReport(report);

    // Export to training data
    ensureDirectories();
    report.entries.forEach((entry) => {
      appendToTrainingData(entry);
    });

    // Delete active report
    const fs = await import('node:fs/promises');
    await fs.unlink(FEEDBACK_FILE);

    sendJson(res, { success: true, archivedReportId: report.reportId });
    return;
  }

  // 404 for unknown paths
  sendError(res, 'Not found', 404);
}

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`[feedback-server] Running on http://localhost:${PORT}`);
  console.log(`[feedback-server] Open http://localhost:${PORT} to view the report`);
});
