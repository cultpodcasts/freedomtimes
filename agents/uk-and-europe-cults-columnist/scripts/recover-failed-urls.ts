import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type BrowserContext } from 'playwright';

type FailedUrlRow = {
  sourceLog?: string;
  url: string;
  message?: string;
  candidateHost?: string;
  blockedHost?: boolean;
};

type AttemptResult = {
  ok: boolean;
  status: number;
  finalUrl: string;
  html: string;
  strategy: 'direct' | 'archive' | 'browser' | 'jina';
};

type RecoveredRow = {
  url: string;
  sourceLog?: string;
  candidateHost?: string;
  blockedHost?: boolean;
  message?: string;
  strategy: AttemptResult['strategy'];
  status: number;
  finalUrl: string;
  textLength: number;
  textPreview: string;
};

const DEFAULT_INPUT = new URL('../reports/failed-urls-blocking-priority.json', import.meta.url);
const OUTPUT_RECOVERED = new URL('../reports/recovered-failed-urls.json', import.meta.url);
const OUTPUT_UNRECOVERED = new URL('../reports/unrecovered-failed-urls.json', import.meta.url);
const OUTPUT_SUMMARY = new URL('../reports/recovered-failed-urls-summary.json', import.meta.url);
const USER_AGENT =
  process.env.HTTP_USER_AGENT?.trim() ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const BROWSER_RENDER_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.BROWSER_RENDER_TIMEOUT_MS ?? '25000', 10) || 25000,
);

const BOT_BLOCK_STATUSES = new Set([403, 429, 451]);

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(withoutScripts).replace(/\s+/g, ' ').trim();
}

async function fetchDirect(url: string): Promise<AttemptResult> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(BROWSER_RENDER_TIMEOUT_MS),
  });

  return {
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    html: await response.text(),
    strategy: 'direct',
  };
}

async function fetchArchive(url: string): Promise<AttemptResult> {
  const archiveUrl = `https://archive.ph/newest/${url}`;
  const response = await fetch(archiveUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(BROWSER_RENDER_TIMEOUT_MS),
  });

  return {
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    html: await response.text(),
    strategy: 'archive',
  };
}

async function fetchBrowser(url: string, context: BrowserContext): Promise<AttemptResult> {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_RENDER_TIMEOUT_MS,
    });

    // Some anti-bot pages resolve after a short browser challenge delay.
    await page.waitForTimeout(4500);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(800);

    return {
      ok: (response?.status() ?? 200) >= 200 && (response?.status() ?? 200) < 300,
      status: response?.status() ?? 200,
      finalUrl: page.url(),
      html: await page.content(),
      strategy: 'browser',
    };
  } finally {
    await page.close();
  }
}

async function fetchJinaMirror(url: string): Promise<AttemptResult> {
  const mirrorUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//i, '')}`;
  const response = await fetch(mirrorUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/plain,text/html;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(BROWSER_RENDER_TIMEOUT_MS),
  });

  return {
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    html: await response.text(),
    strategy: 'jina',
  };
}

async function main(): Promise<void> {
  const inputArg = process.argv[2]?.trim();
  const inputPath = inputArg
    ? new URL(inputArg, `file://${process.cwd().replace(/\\/g, '/')}/`)
    : DEFAULT_INPUT;

  const max = Math.max(0, Number.parseInt(process.env.RECOVERY_MAX ?? '0', 10) || 0);

  const failedRows = JSON.parse(readFileSync(inputPath, 'utf-8')) as FailedUrlRow[];
  const uniqueByUrl = new Map<string, FailedUrlRow>();
  for (const row of failedRows) {
    if (!uniqueByUrl.has(row.url)) {
      uniqueByUrl.set(row.url, row);
    }
  }

  const worklist = Array.from(uniqueByUrl.values());
  const selected = max > 0 ? worklist.slice(0, max) : worklist;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'en-GB',
    extraHTTPHeaders: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9',
    },
  });

  const recovered: RecoveredRow[] = [];
  const unrecovered: Array<FailedUrlRow & { attempts: Array<{ strategy: string; status: number; finalUrl: string; error?: string }> }> = [];
  const strategyCounts = { direct: 0, archive: 0, browser: 0, jina: 0 };

  try {
    let processed = 0;
    for (const row of selected) {
      processed += 1;
      const attempts: Array<{ strategy: string; status: number; finalUrl: string; error?: string }> = [];

      try {
        const direct = await fetchDirect(row.url);
        attempts.push({ strategy: direct.strategy, status: direct.status, finalUrl: direct.finalUrl });
        if (direct.ok) {
          const text = htmlToText(direct.html);
          recovered.push({
            ...row,
            strategy: direct.strategy,
            status: direct.status,
            finalUrl: direct.finalUrl,
            textLength: text.length,
            textPreview: text.slice(0, 4000),
          });
          strategyCounts.direct += 1;
          console.log(`[agent] recovered ${processed}/${selected.length}`, { strategy: 'direct', url: row.url, textLength: text.length });
          continue;
        }

        if (BOT_BLOCK_STATUSES.has(direct.status)) {
          const archive = await fetchArchive(row.url);
          attempts.push({ strategy: archive.strategy, status: archive.status, finalUrl: archive.finalUrl });
          if (archive.ok) {
            const text = htmlToText(archive.html);
            recovered.push({
              ...row,
              strategy: archive.strategy,
              status: archive.status,
              finalUrl: archive.finalUrl,
              textLength: text.length,
              textPreview: text.slice(0, 4000),
            });
            strategyCounts.archive += 1;
            console.log(`[agent] recovered ${processed}/${selected.length}`, { strategy: 'archive', url: row.url, textLength: text.length });
            continue;
          }

          const browserResult = await fetchBrowser(row.url, context);
          attempts.push({ strategy: browserResult.strategy, status: browserResult.status, finalUrl: browserResult.finalUrl });
          if (browserResult.ok) {
            const text = htmlToText(browserResult.html);
            recovered.push({
              ...row,
              strategy: browserResult.strategy,
              status: browserResult.status,
              finalUrl: browserResult.finalUrl,
              textLength: text.length,
              textPreview: text.slice(0, 4000),
            });
            strategyCounts.browser += 1;
            console.log(`[agent] recovered ${processed}/${selected.length}`, { strategy: 'browser', url: row.url, textLength: text.length });
            continue;
          }
        }

        try {
          const jina = await fetchJinaMirror(row.url);
          attempts.push({ strategy: jina.strategy, status: jina.status, finalUrl: jina.finalUrl });
          if (jina.ok) {
            const text = htmlToText(jina.html);
            recovered.push({
              ...row,
              strategy: jina.strategy,
              status: jina.status,
              finalUrl: jina.finalUrl,
              textLength: text.length,
              textPreview: text.slice(0, 4000),
            });
            strategyCounts.jina += 1;
            console.log(`[agent] recovered ${processed}/${selected.length}`, { strategy: 'jina', url: row.url, textLength: text.length });
            continue;
          }
        } catch (error) {
          attempts.push({
            strategy: 'jina',
            status: 0,
            finalUrl: row.url,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        unrecovered.push({ ...row, attempts });
        console.log(`[agent] unrecovered ${processed}/${selected.length}`, { url: row.url, attempts });
      } catch (error) {
        attempts.push({
          strategy: 'exception',
          status: 0,
          finalUrl: row.url,
          error: error instanceof Error ? error.message : String(error),
        });
        unrecovered.push({ ...row, attempts });
        console.log(`[agent] unrecovered ${processed}/${selected.length}`, { url: row.url, attempts });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(OUTPUT_RECOVERED, `${JSON.stringify(recovered, null, 2)}\n`, 'utf-8');
  writeFileSync(OUTPUT_UNRECOVERED, `${JSON.stringify(unrecovered, null, 2)}\n`, 'utf-8');

  const summary = {
    source: inputPath.pathname,
    selected: selected.length,
    recovered: recovered.length,
    unrecovered: unrecovered.length,
    strategyCounts,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(OUTPUT_SUMMARY, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
  console.log('[agent] recovery summary', summary);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[agent] failed to recover failed urls', { message });
  process.exitCode = 1;
});
