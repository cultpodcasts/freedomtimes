/**
 * Isolate headline, dek, and article body from publisher site chrome.
 * Shared by the pipeline (classification) and cult-news HTML renderer (clustering).
 */

export type PageMetadata = {
  title?: string;
  description?: string;
  image?: string;
  publishedAt?: string;
  htmlLang?: string;
};

/** Known suffixes after ` | ` or ` - ` on <title> / og:title (publisher name, not story). */
const PUBLISHER_TITLE_SUFFIXES = [
  'the independent',
  'the guardian',
  'bbc news',
  'sky news',
  'daily mail online',
  'the telegraph',
  'financial times',
  'irish independent',
  'the times',
  'the sun',
  'mirror online',
  'huffpost uk',
  'bfmtv',
  'france 24',
  'lead stories',
  'international business times',
  'stern.de',
  'gala.de',
  'bol uol',
  'uol',
];

/** Leading plain-text blobs from paywalls, notifications, nav (applied repeatedly). */
const LEADING_PLAIN_CHROME_PATTERNS: RegExp[] = [
  /^Get full access to the app\s*&\s*website:\s*Subscribe\s*/i,
  /^Stay up to date with notifications from[^.]{0,200}\.\s*/i,
  /^Notifications can be managed in browser preferences\.\s*/i,
  /^Not now\s+Yes please\s*/i,
  /^Swipe for next article\s*/i,
  /^Good News\s+Our Picks\s+Business Analysis[\s\S]{0,400}?(?=The Independent|National\b|[A-Z][a-z]{4,})/i,
  /^Get all your news in one place\.[\s\S]{0,350}?(?=[A-Z][a-z]{4,})/i,
  /^Bookmark\s+Comments\s*/i,
  /^Suche\s+Suchen\s+Eingabe löschen\s*/i,
  /^Anzeige\s+Stars\s+News\s*/i,
  /^Comments\s+News\s+/i,
  /^View \d+ Images\s+/i,
  /^Lead Stories\s+/i,
  /^Site Menu\s+News\s+Reviews[\s\S]{0,400}?(?=\d{4}|[A-Z]{3,})/i,
  /^\d+ days ago\s+Share\s+Save\s+Add[\s\S]{0,350}?(?=[A-Z][a-z]{3,})/i,
  /^Share\s+Save\s+Add as preferred on Google\s+/i,
  /^Site Menu[\s\S]*?\d{1,2}:\d{2}\s+[AP]M\s+/i,
];

/** Cut article body before related-content / comment widgets. */
const TRAILING_PLAIN_CHROME_PATTERNS: RegExp[] = [
  /\bRelated articles?:[\s\S]*$/i,
  /\bRelated topics?:[\s\S]*$/i,
  /\bMore on this (?:story|topic):[\s\S]*$/i,
  /\bRead more on[\s\S]*$/i,
  /\bJoin the discussion[\s\S]*$/i,
  /\bComments\s+Join the conversation[\s\S]*$/i,
  /\bShare this article[\s\S]*$/i,
  /\bMost read[\s\S]*$/i,
  /\bMore stories from[\s\S]*$/i,
  /\bAdvertisement[\s\S]*$/i,
  /\bSource:\s*\S+\s*\(https?:\/\/[^\s)]+\)\s*$/i,
  /\bDo you feel this content is inappropriate[\s\S]*$/i,
  /\bSubscribe to Screen Anarchy[\s\S]*$/i,
  /\bBe Anarchist![\s\S]*$/i,
  /\bRecent Posts[\s\S]*$/i,
  /\bLeading Voices in Global Cinema[\s\S]*$/i,
  /\bAbout ScreenAnarchy[\s\S]*$/i,
  /\bAll content ©[\s\S]*$/i,
];

const NON_ARTICLE_HTML_CLASS_FRAGMENT =
  'article-readmore|read-more|readmore|related|recommended|most-read|popular|newsletter|subscribe|paywall|share-tools|share-tools|social-share|comments|commenting|bookmark|promo|advert|advertisement|sidebar|breadcrumb|navigation|mega-menu|site-header|site-footer|header-inner|footer-inner|notification|consent|cookie|banner|outbrain|taboola|related-stories|more-stories|article__share|sharebar|sharing-bar';

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_, hex, dec) =>
      String.fromCodePoint(hex ? parseInt(hex, 16) : parseInt(dec, 10)),
    )
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&ldquo;/gi, '\u201c')
    .replace(/&rdquo;/gi, '\u201d')
    .replace(/&hellip;/gi, '\u2026');
}

function getMetaContent(html: string, key: string, type: 'property' | 'name'): string | undefined {
  const attr = type === 'property' ? 'property' : 'name';
  const pattern = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const altPattern = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${key}["'][^>]*>`, 'i');
  return html.match(pattern)?.[1]?.trim() ?? html.match(altPattern)?.[1]?.trim();
}

function normalizeIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function findDatePublishedInJsonValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findDatePublishedInJsonValue(item);
      if (nested) return nested;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct =
    normalizeIso(typeof record.datePublished === 'string' ? record.datePublished : undefined) ??
    normalizeIso(typeof record.dateCreated === 'string' ? record.dateCreated : undefined) ??
    normalizeIso(typeof record.dateModified === 'string' ? record.dateModified : undefined);
  if (direct) return direct;
  for (const nested of Object.values(record)) {
    const nestedDate = findDatePublishedInJsonValue(nested);
    if (nestedDate) return nestedDate;
  }
  return undefined;
}

function detectPublishedAtFromJsonLd(html: string): string | undefined {
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null = scriptRegex.exec(html);
  while (match) {
    const rawJson = match[1]?.trim();
    if (rawJson) {
      try {
        const detected = findDatePublishedInJsonValue(JSON.parse(rawJson) as unknown);
        if (detected) return detected;
      } catch {
        // malformed JSON-LD
      }
    }
    match = scriptRegex.exec(html);
  }
  return undefined;
}

/** Strip publisher name from page title; prefer story headline. */
export function cleanDisplayTitle(rawTitle: string): string {
  let title = decodeHtmlEntities(rawTitle).replace(/\s+/g, ' ').trim();
  if (!title) return title;

  for (const sep of [' | ', ' – ', ' — ', ' - ']) {
    const idx = title.lastIndexOf(sep);
    if (idx <= 0) continue;
    const head = title.slice(0, idx).trim();
    const tail = title.slice(idx + sep.length).trim().toLowerCase();
    if (PUBLISHER_TITLE_SUFFIXES.some((s) => tail === s || tail.startsWith(`${s} `))) {
      title = head;
    }
  }

  return title;
}

export function extractPageMetadataFromHtml(html: string): PageMetadata {
  const htmlLang = html.match(/<html[^>]+lang=["']([^"']+)["'][^>]*>/i)?.[1]?.trim();

  const rawTitle =
    getMetaContent(html, 'og:title', 'property') ??
    getMetaContent(html, 'twitter:title', 'name') ??
    html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();

  const description =
    getMetaContent(html, 'og:description', 'property') ??
    getMetaContent(html, 'description', 'name') ??
    getMetaContent(html, 'twitter:description', 'name');

  const image =
    getMetaContent(html, 'og:image', 'property') ??
    getMetaContent(html, 'twitter:image', 'name') ??
    getMetaContent(html, 'og:image:url', 'property');

  const publishedAt = normalizeIso(
    getMetaContent(html, 'article:published_time', 'property') ??
      getMetaContent(html, 'article:published_time', 'name') ??
      getMetaContent(html, 'og:published_time', 'property') ??
      getMetaContent(html, 'pubdate', 'name') ??
      getMetaContent(html, 'publishdate', 'name') ??
      html.match(/<time[^>]+datetime=["']([^"']+)["'][^>]*>/i)?.[1],
  ) ?? detectPublishedAtFromJsonLd(html);

  return {
    title: rawTitle ? cleanDisplayTitle(rawTitle) : undefined,
    description: description ? decodeHtmlEntities(description) : undefined,
    image,
    publishedAt,
    htmlLang,
  };
}

/** Remove nav, related, comments, share blocks before text extraction. */
export function removeNonArticleBlocksFromHtml(html: string): string {
  return html
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(
      new RegExp(
        `<(?:div|section|aside|ul|ol)[^>]+class=["'][^"']*(?:${NON_ARTICLE_HTML_CLASS_FRAGMENT})[^"']*["'][^>]*>[\\s\\S]*?<\\/(?:div|section|aside|ul|ol)>`,
        'gi',
      ),
      ' ',
    )
    .replace(
      /<(?:div|section)[^>]+(?:id|data-testid|data-component)=["'][^"']*(?:share|comment|related|newsletter|promo|sidebar)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section)>/gi,
      ' ',
    );
}

function htmlToPlainText(htmlFragment: string): string {
  return decodeHtmlEntities(
    htmlFragment
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

const NAV_LEAD_MARKERS = [
  /^site menu\b/i,
  /\bsite menu news reviews\b/i,
  /^news reviews interviews videos\b/i,
  /^\d+ days ago share save\b/i,
  /^share save add as preferred\b/i,
];

function scoreArticleHtmlFragment(htmlFragment: string): number {
  const stripped = removeNonArticleBlocksFromHtml(htmlFragment);
  const plain = stripLeadingAndTrailingSiteChrome(htmlToPlainText(stripped));
  if (plain.length < 120) {
    return 0;
  }

  let score = plain.length;
  const paragraphCount = (stripped.match(/<p\b[^>]*>/gi) ?? []).length;
  score += paragraphCount * 50;

  const lead = plain.slice(0, 220);
  for (const marker of NAV_LEAD_MARKERS) {
    if (marker.test(lead)) {
      score -= 800;
    }
  }

  const headWords = lead.split(/\s+/).filter(Boolean);
  if (headWords.length >= 10) {
    const shortWords = headWords.filter((word) => word.length <= 5).length;
    if (shortWords / headWords.length > 0.8) {
      score -= 400;
    }
  }

  return score;
}

function pushHtmlCandidate(candidates: string[], fragment: string | undefined): void {
  if (!fragment) {
    return;
  }
  const trimmed = fragment.trim();
  if (trimmed.length < 80) {
    return;
  }
  if (!candidates.includes(trimmed)) {
    candidates.push(trimmed);
  }
}

function collectArticleHtmlCandidates(html: string): string[] {
  const candidates: string[] = [];

  for (const match of html.matchAll(
    /<(?:div|section|article)[^>]+itemprop=["']articleBody["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/gi,
  )) {
    pushHtmlCandidate(candidates, match[1]);
  }

  for (const match of html.matchAll(
    /<(?:div|section|article)[^>]+itemtype=["'][^"']*schema\.org\/(?:news)?article["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/gi,
  )) {
    pushHtmlCandidate(candidates, match[1]);
  }

  for (const match of html.matchAll(/<(?:div|section|main)[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/(?:div|section|main)>/gi)) {
    pushHtmlCandidate(candidates, match[1]);
  }

  for (const match of html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) {
    pushHtmlCandidate(candidates, match[1]);
  }

  for (const match of html.matchAll(
    /<(?:div|section)[^>]+class=["'][^"']*(?:article-body|article__body|post-content|entry-content|story-body|article-content)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/gi,
  )) {
    pushHtmlCandidate(candidates, match[1]);
  }

  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  pushHtmlCandidate(candidates, mainMatch?.[1]);

  return candidates;
}

function extractArticleBodyHtml(html: string): string {
  const candidates = collectArticleHtmlCandidates(html);
  if (candidates.length === 0) {
    return html;
  }

  let best = candidates[0]!;
  let bestScore = scoreArticleHtmlFragment(best);
  for (const candidate of candidates.slice(1)) {
    const score = scoreArticleHtmlFragment(candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (bestScore >= 120) {
    return best;
  }

  return html;
}

export function stripLeadingAndTrailingSiteChrome(plainText: string): string {
  let text = plainText.replace(/\s+/g, ' ').trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of LEADING_PLAIN_CHROME_PATTERNS) {
      const next = text.replace(pattern, '').trim();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }
  for (const pattern of TRAILING_PLAIN_CHROME_PATTERNS) {
    text = text.replace(pattern, '').trim();
  }
  return text;
}

/** Drop duplicated title/nav blob before the real lede (e.g. ScreenAnarchy). */
export function stripDuplicateHeadlineLead(plainText: string): string {
  const text = plainText.replace(/\s+/g, ' ').trim();
  const navCut = text.replace(/^[\s\S]*?\bSite Menu\b[\s\S]*?\d{1,2}:\d{2}\s+[AP]M\s+/i, '').trim();
  if (navCut.length >= 200 && navCut.length < text.length) {
    return navCut;
  }
  return text;
}

/** Post-process already-extracted plain article text. */
export function cleanArticlePlainText(text: string, maxLen = 6000): string {
  return stripDuplicateHeadlineLead(stripLeadingAndTrailingSiteChrome(text.replace(/\s+/g, ' ').trim())).slice(
    0,
    maxLen,
  );
}

/** Plain article body for NLP / clustering (no site chrome). */
export function htmlToPlainArticleText(html: string, maxLen = 6000): string {
  const articleHtml = extractArticleBodyHtml(html);
  const stripped = removeNonArticleBlocksFromHtml(articleHtml);
  return cleanArticlePlainText(htmlToPlainText(stripped), maxLen);
}
