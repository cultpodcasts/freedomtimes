#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadClusterLayout,
  saveApprovedLayout,
  saveClusterLayout,
  type ClusterLayout,
} from '../src/clusterLayout.ts';
import { buildDigestView } from '../src/digestView.ts';
import { writeReviewReport, loadReviewReportLatest } from '../src/reviewReport.ts';
import {
  buildArticlePlanState,
  finalizeArticlePlan,
  loadFinalizedArticlePlan,
  mergeArticlePlanUnits,
  saveArticlePlanDraft,
  type ArticlePlanState,
} from '../src/articlePlan.ts';
import {
  addEditorImageCandidate,
  collectRoundupImageCandidates,
  mergeCandidatesWithSelections,
  probeExistingRoundupImageCandidates,
  type CollectImageProgressEvent,
  type RoundupImageCandidatesFile,
  type RoundupImageSelectionsFile,
} from '../src/collectRoundupImageCandidates.ts';
import { mimeForFilename } from '../src/draftImageStore.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number.parseInt(process.env.FEEDBACK_SERVER_PORT || '3000', 10);
const REPORTS_DIR = join(__dirname, '../reports');
const DRAFTS_DIR = join(REPORTS_DIR, 'drafts');
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

const FEEDBACK_UI_HTML = join(__dirname, 'feedback-ui.html');
const FEEDBACK_UI_JS = join(__dirname, 'feedback-ui.js');
const FEEDBACK_UI_CSS = join(__dirname, 'feedback-ui.css');
const ARTICLE_PLAN_UI_HTML = join(__dirname, 'article-plan-ui.html');
const ARTICLE_PLAN_UI_JS = join(__dirname, 'article-plan-ui.js');
const ARTICLE_PLAN_UI_CSS = join(__dirname, 'article-plan-ui.css');
const DRAFT_IMAGES_UI_HTML = join(__dirname, 'draft-images-ui.html');
const DRAFT_IMAGES_UI_JS = join(__dirname, 'draft-images-ui.js');
const DRAFT_IMAGES_UI_CSS = join(__dirname, 'draft-images-ui.css');

function draftImagesPath(slug: string, kind: 'candidates' | 'selections'): string {
  return join(DRAFTS_DIR, `${slug}-image-${kind}.json`);
}

function loadDraftImageCandidates(slug: string): RoundupImageCandidatesFile | null {
  const p = draftImagesPath(slug, 'candidates');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as RoundupImageCandidatesFile;
}

function loadDraftImageSelections(slug: string): RoundupImageSelectionsFile | null {
  const p = draftImagesPath(slug, 'selections');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as RoundupImageSelectionsFile;
}

function serveStaticFile(res: ServerResponse, filePath: string, contentType: string, corsHeaders: Record<string, string>): void {
  if (!existsSync(filePath)) {
    sendError(res, `Missing ${filePath}`, 404);
    return;
  }
  const body = readFileSync(filePath, 'utf-8');
  res.writeHead(200, { ...corsHeaders, 'Content-Type': contentType });
  res.end(body);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  return JSON.parse(body) as T;
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

  // Dynamic feedback shell (loads digest from /api/digest/view)
  if (path === '/' || path === '/index.html') {
    serveStaticFile(res, FEEDBACK_UI_HTML, 'text/html; charset=utf-8', corsHeaders);
    return;
  }

  if (path === '/feedback-ui.js') {
    serveStaticFile(res, FEEDBACK_UI_JS, 'application/javascript; charset=utf-8', corsHeaders);
    return;
  }

  if (path === '/feedback-ui.css') {
    serveStaticFile(res, FEEDBACK_UI_CSS, 'text/css; charset=utf-8', corsHeaders);
    return;
  }

  // Article planning UI (post-finalize)
  if (path === '/articles' || path === '/article-plan') {
    serveStaticFile(res, ARTICLE_PLAN_UI_HTML, 'text/html; charset=utf-8', corsHeaders);
    return;
  }

  if (path === '/article-plan-ui.js') {
    serveStaticFile(res, ARTICLE_PLAN_UI_JS, 'application/javascript; charset=utf-8', corsHeaders);
    return;
  }

  if (path === '/article-plan-ui.css') {
    serveStaticFile(res, ARTICLE_PLAN_UI_CSS, 'text/css; charset=utf-8', corsHeaders);
    return;
  }

  if (path === '/draft-images') {
    serveStaticFile(res, DRAFT_IMAGES_UI_HTML, 'text/html; charset=utf-8', corsHeaders);
    return;
  }

  if (path === '/draft-images-ui.js') {
    serveStaticFile(res, DRAFT_IMAGES_UI_JS, 'application/javascript; charset=utf-8', corsHeaders);
    return;
  }

  if (path === '/draft-images-ui.css') {
    serveStaticFile(res, DRAFT_IMAGES_UI_CSS, 'text/css; charset=utf-8', corsHeaders);
    return;
  }

  // Static HTML export (optional — same content as pre-refactor file:// flow)
  if (path === '/export' || path === '/export.html') {
    const reportPath = join(REPORTS_DIR, 'cult-news-latest.html');
    if (!existsSync(reportPath)) {
      res.writeHead(404, { ...corsHeaders, 'Content-Type': 'text/plain' });
      res.end('Export not found. Run: npm run render:html');
      return;
    }
    const html = readFileSync(reportPath, 'utf-8');
    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // API: Review report for summariser (clusters, urls, article text, signals)
  if (path === '/api/report/result' && req.method === 'GET') {
    try {
      const existing = loadReviewReportLatest();
      if (existing) {
        sendJson(res, existing);
        return;
      }
      const report = await writeReviewReport();
      sendJson(res, report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 404);
    }
    return;
  }

  // API: Digest view (corpus + feedback state, no full re-render)
  if (path === '/api/digest/view' && req.method === 'GET') {
    try {
      const report = loadActiveReport();
      const excludePersistedFalsePositives = report?.status !== 'review';
      const view = await buildDigestView({ excludePersistedFalsePositives });
      sendJson(res, view);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 404);
    }
    return;
  }

  // API: Article plan (post-finalize story → article assignments)
  if (path === '/api/article-plan' && req.method === 'GET') {
    try {
      const plan = buildArticlePlanState();
      sendJson(res, plan);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 404);
    }
    return;
  }

  if (path === '/api/article-plan' && req.method === 'PUT') {
    try {
      const data = await readJsonBody<{
        articles?: ArticlePlanState['articles'];
        assignments?: ArticlePlanState['assignments'];
      }>(req);
      const plan = buildArticlePlanState();
      if (plan.status === 'finalized') {
        sendError(res, 'Article plan is finalized. Reset reports/article-plan.json to edit.', 400);
        return;
      }
      if (data.articles) {
        plan.articles = data.articles;
      }
      if (data.assignments) {
        plan.assignments = data.assignments;
      }
      saveArticlePlanDraft(plan);
      sendJson(res, buildArticlePlanState());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 400);
    }
    return;
  }

  if (path === '/api/article-plan/finalize' && req.method === 'POST') {
    try {
      const report = loadReviewReportLatest();
      if (!report) {
        sendError(res, 'No review report found', 404);
        return;
      }
      const plan = buildArticlePlanState(report);
      if (plan.status === 'finalized') {
        const existing = loadFinalizedArticlePlan();
        sendJson(res, { success: true, alreadyFinalized: true, ...existing });
        return;
      }
      const finalized = finalizeArticlePlan(plan, report);
      sendJson(res, {
        success: true,
        articleCount: finalized.articleCount,
        skippedCount: finalized.skippedCount,
        finalizedAt: finalized.finalizedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 400);
    }
    return;
  }

  if (path === '/api/article-plan/result' && req.method === 'GET') {
    const finalized = loadFinalizedArticlePlan();
    if (!finalized) {
      sendError(res, 'No finalized article plan. Complete /articles first.', 404);
      return;
    }
    sendJson(res, finalized);
    return;
  }

  // Draft roundup images — collect, review, save selections
  if (path === '/api/draft-images' && req.method === 'GET') {
    const slug = new URL(req.url ?? '', `http://localhost:${PORT}`).searchParams.get('slug');
    if (!slug) {
      sendError(res, 'slug query parameter required');
      return;
    }
    const candidates = loadDraftImageCandidates(slug);
    if (!candidates) {
      sendError(res, `No candidates for ${slug}. POST /api/draft-images/collect first.`, 404);
      return;
    }
    const selections = loadDraftImageSelections(slug);
    const units = mergeCandidatesWithSelections(candidates, selections);
    sendJson(res, { slug, units });
    return;
  }

  const customImageMatch = path.match(/^\/api\/draft-images\/custom\/([^/]+)\/([^/]+)$/);
  if (customImageMatch && req.method === 'GET') {
    const slug = decodeURIComponent(customImageMatch[1]!);
    const filename = decodeURIComponent(customImageMatch[2]!);
    const filePath = join(DRAFTS_DIR, '_custom', slug, filename);
    if (!existsSync(filePath)) {
      sendError(res, 'Custom image not found', 404);
      return;
    }
    const body = readFileSync(filePath);
    res.writeHead(200, { ...corsHeaders, 'Content-Type': mimeForFilename(filename) });
    res.end(body);
    return;
  }

  if (path === '/api/draft-images/collect-stream' && req.method === 'GET') {
    const slug = url.searchParams.get('slug')?.trim();
    if (!slug) {
      sendError(res, 'slug query parameter required');
      return;
    }
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const sendProgress = (event: CollectImageProgressEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      if (!existsSync(DRAFTS_DIR)) {
        mkdirSync(DRAFTS_DIR, { recursive: true });
      }
      const result = await collectRoundupImageCandidates(
        slug,
        undefined,
        { onProgress: sendProgress },
        DRAFTS_DIR,
      );
      writeFileSync(draftImagesPath(slug, 'candidates'), JSON.stringify(result, null, 2), 'utf8');
      sendProgress({
        level: 'done',
        message: `Saved ${result.units.length} units`,
        percent: 100,
        totalUnits: result.units.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendProgress({ level: 'error', message });
    }
    res.end();
    return;
  }

  if (path === '/api/draft-images/collect' && req.method === 'POST') {
    try {
      const data = await readJsonBody<{ slug?: string }>(req);
      const slug = data.slug?.trim();
      if (!slug) {
        sendError(res, 'slug required');
        return;
      }
      if (!existsSync(DRAFTS_DIR)) {
        mkdirSync(DRAFTS_DIR, { recursive: true });
      }
      const result = await collectRoundupImageCandidates(slug, undefined, {}, DRAFTS_DIR);
      writeFileSync(draftImagesPath(slug, 'candidates'), JSON.stringify(result, null, 2), 'utf8');
      sendJson(res, { success: true, unitCount: result.units.length, path: draftImagesPath(slug, 'candidates') });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 400);
    }
    return;
  }

  if (path === '/api/draft-images/probe' && req.method === 'POST') {
    try {
      const data = await readJsonBody<{ slug?: string }>(req);
      const slug = data.slug?.trim();
      if (!slug) {
        sendError(res, 'slug required');
        return;
      }
      const existing = loadDraftImageCandidates(slug);
      if (!existing) {
        sendError(res, `No candidates for ${slug}`, 404);
        return;
      }
      const result = await probeExistingRoundupImageCandidates(existing, {}, DRAFTS_DIR);
      writeFileSync(draftImagesPath(slug, 'candidates'), JSON.stringify(result, null, 2), 'utf8');
      sendJson(res, { success: true, unitCount: result.units.length, collectedAt: result.collectedAt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 400);
    }
    return;
  }

  if (path === '/api/draft-images/probe-stream' && req.method === 'GET') {
    const slug = url.searchParams.get('slug')?.trim();
    if (!slug) {
      sendError(res, 'slug query parameter required');
      return;
    }
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const sendProgress = (event: CollectImageProgressEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      const existing = loadDraftImageCandidates(slug);
      if (!existing) {
        sendProgress({ level: 'error', message: `No candidates for ${slug}` });
        res.end();
        return;
      }
      const result = await probeExistingRoundupImageCandidates(
        existing,
        { onProgress: sendProgress },
        DRAFTS_DIR,
      );
      writeFileSync(draftImagesPath(slug, 'candidates'), JSON.stringify(result, null, 2), 'utf8');
      sendProgress({
        level: 'done',
        message: `Quality updated for ${result.units.length} units`,
        percent: 100,
        totalUnits: result.units.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendProgress({ level: 'error', message });
    }
    res.end();
    return;
  }

  if (path === '/api/draft-images/add' && req.method === 'POST') {
    try {
      const data = await readJsonBody<{
        slug?: string;
        unitId?: string;
        url?: string;
        imageBase64?: string;
      }>(req);
      const slug = data.slug?.trim();
      const unitId = data.unitId?.trim();
      if (!slug || !unitId) {
        sendError(res, 'slug and unitId required');
        return;
      }
      if (!data.url?.trim() && !data.imageBase64) {
        sendError(res, 'url or imageBase64 required');
        return;
      }
      const origin = `http://${req.headers.host ?? `localhost:${PORT}`}`;
      const { candidate, selectedUrl } = await addEditorImageCandidate(
        DRAFTS_DIR,
        slug,
        unitId,
        { url: data.url, imageBase64: data.imageBase64 },
        origin,
      );
      sendJson(res, { success: true, candidate, selectedUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 400);
    }
    return;
  }

  if (path === '/api/draft-images' && req.method === 'PUT') {
    try {
      const data = await readJsonBody<RoundupImageSelectionsFile>(req);
      if (!data.slug?.trim() || !data.units) {
        sendError(res, 'slug and units required');
        return;
      }
      if (!existsSync(DRAFTS_DIR)) {
        mkdirSync(DRAFTS_DIR, { recursive: true });
      }
      const payload: RoundupImageSelectionsFile = {
        slug: data.slug.trim(),
        savedAt: new Date().toISOString(),
        units: data.units,
      };
      writeFileSync(draftImagesPath(payload.slug, 'selections'), JSON.stringify(payload, null, 2), 'utf8');
      sendJson(res, { success: true, savedAt: payload.savedAt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 400);
    }
    return;
  }

  if (path === '/api/article-plan/merge-units' && req.method === 'POST') {
    try {
      const data = await readJsonBody<{ unitIds?: string[]; label?: string }>(req);
      if (!data.unitIds || data.unitIds.length < 2) {
        sendError(res, 'unitIds must include at least two units');
        return;
      }
      if (!data.label?.trim()) {
        sendError(res, 'label is required');
        return;
      }
      const plan = await mergeArticlePlanUnits(data.unitIds, data.label.trim());
      sendJson(res, plan);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, message, 400);
    }
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

  // API: Reset active report (clear in-progress session only)
  if (path === '/api/report/reset' && req.method === 'POST') {
    if (!existsSync(FEEDBACK_FILE)) {
      sendJson(res, { success: true, status: 'none' });
      return;
    }
    const fs = await import('node:fs/promises');
    await fs.unlink(FEEDBACK_FILE);
    sendJson(res, { success: true, status: 'none' });
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

    report.status = 'verification';
    saveActiveReport(report);
    const reviewReport = await writeReviewReport({ archivedSessionId: report.reportId });
    sendJson(res, {
      success: true,
      status: 'verification',
      reviewReportId: reviewReport.reportId,
      visibleStoryCount: reviewReport.visibleStoryCount,
    });
    return;
  }

  // API: Get saved cluster layout
  if (path === '/api/cluster-layout' && req.method === 'GET') {
    sendJson(res, { layout: loadClusterLayout() });
    return;
  }

  // API: Save cluster layout without re-render
  if (path === '/api/cluster-layout' && req.method === 'PUT') {
    const data = await readJsonBody<{ layout?: ClusterLayout }>(req);
    if (!data.layout || !Array.isArray(data.layout.clusters) || !Array.isArray(data.layout.independentUrls)) {
      sendError(res, 'layout with clusters and independentUrls is required');
      return;
    }
    data.layout.updatedAt = new Date().toISOString();
    saveClusterLayout(data.layout);
    const reviewReport = await writeReviewReport();
    sendJson(res, { success: true, reviewReportId: reviewReport.reportId });
    return;
  }

  // API: Save layout and re-render digest (verification phase)
  if (path === '/api/report/apply-layout' && req.method === 'POST') {
    const report = loadActiveReport();
    if (!report) {
      sendError(res, 'No active report', 404);
      return;
    }
    if (report.status !== 'verification') {
      sendError(res, 'Layout edits require verification phase', 400);
      return;
    }

    const data = await readJsonBody<{ layout?: ClusterLayout }>(req);
    if (!data.layout || !Array.isArray(data.layout.clusters) || !Array.isArray(data.layout.independentUrls)) {
      sendError(res, 'layout with clusters and independentUrls is required');
      return;
    }
    data.layout.updatedAt = new Date().toISOString();
    saveClusterLayout(data.layout);
    const reviewReport = await writeReviewReport();
    sendJson(res, { success: true, reviewReportId: reviewReport.reportId });
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

    const layout = loadClusterLayout();
    if (layout) {
      saveApprovedLayout(layout);
      console.log('[feedback-server] wrote approved layout to reports/approved-layout.json');
    }

    // Export to training data
    ensureDirectories();
    report.entries.forEach((entry) => {
      appendToTrainingData(entry);
    });

    // Delete active report
    const fs = await import('node:fs/promises');
    await fs.unlink(FEEDBACK_FILE);

    const reviewReport = await writeReviewReport({
      reportId: report.reportId,
      archivedSessionId: report.reportId,
    });
    console.log('[feedback-server] wrote review report to reports/review-report-latest.json');

    sendJson(res, {
      success: true,
      archivedReportId: report.reportId,
      reviewReportId: reviewReport.reportId,
      visibleStoryCount: reviewReport.visibleStoryCount,
      clusterCount: reviewReport.clusters.length,
    });
    return;
  }

  // 404 for unknown paths
  sendError(res, 'Not found', 404);
}

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`[feedback-server] Running on http://localhost:${PORT}`);
  console.log(`[feedback-server] Open http://localhost:${PORT} to view the report`);
  console.log(`[feedback-server] Article plan: http://localhost:${PORT}/articles`);
  console.log(`[feedback-server] Draft images: http://localhost:${PORT}/draft-images`);
});
