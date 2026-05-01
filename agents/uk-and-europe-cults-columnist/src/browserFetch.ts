import type { CachedFetchResult } from './http-cache/types.js';
import { BROWSER_RENDER_TIMEOUT_MS, HTTP_USER_AGENT } from './http-cache/config.js';

export async function fetchTextWithBrowserRender(url: string): Promise<CachedFetchResult> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      userAgent: HTTP_USER_AGENT,
      locale: 'en-GB',
      extraHTTPHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });

    const page = await context.newPage();

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: BROWSER_RENDER_TIMEOUT_MS,
      });

      const html = await page.content();
      const finalUrl = page.url();
      const status = response?.status() ?? 200;
      const ok = status >= 200 && status < 300;

      return {
        ok,
        status,
        url: finalUrl,
        headers: {},
        text: html,
        fromCache: false,
      };
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
