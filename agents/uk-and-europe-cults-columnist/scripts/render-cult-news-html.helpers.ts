/// <reference types="node" />
import { extractPageMetadataFromHtml, htmlToPlainArticleText } from '../src/articleContent.ts';
import {
  buildArchiveMirrorLinks,
  getCanonicalArticleUrl,
  looksLikeBlockedFetchPage,
  needsArchiveMirrorFallback,
  type ArchiveMirrorLink,
} from '../src/archiveMirrors.ts';
import { ARCHIVE_FALLBACK_HOSTS, BROWSER_RENDER_FALLBACK_STATUS_CODES, HTTP_USER_AGENT } from '../src/http-cache/config.ts';
import { fetchTextResilient } from '../src/resilientFetch.ts';
import type { StorySourceCitation } from '../src/sourceCitation.ts';
import { pathToFileURL } from 'node:url';

export type DraftStory = {
  title: string;
  url: string;
  host?: string;
  publishedAt?: string;
  contentMirrorUrl?: string;
  classificationAudit?: CultClassificationAudit;
};

export type StoryMeta = {
  title?: string;
  description?: string;
  image?: string;
  publishedAt?: string;
  articleText?: string;
  htmlLang?: string;
  contentMirrorUrl?: string;
  archiveMirrorLinks?: ArchiveMirrorLink[];
};

export type CultClassificationAudit = {
  matchedTerms: string[];
  matchLocations: string[];
  matchContexts: string[];
  classificationSource: string;
  filtersChecked: string[];
  filterResults: Record<string, { passed: boolean; reason?: string }>;
  classifiedAt: string;
};

export type EnrichedStory = DraftStory & {
  description: string;
  image?: string;
  articleText: string;
  htmlLang?: string;
  archiveMirrorLinks?: ArchiveMirrorLink[];
  sourceCitation?: StorySourceCitation;
  classificationAudit?: CultClassificationAudit;
};

export type RunSummary = Record<string, number>;

type VNode = {
  tag: string;
  props: Record<string, unknown>;
  children: Array<VNode | string | number>;
};

type Child = VNode | string | number | boolean | null | undefined | Child[];

const VOID_TAGS = new Set(['meta', 'link', 'img', 'br', 'hr', 'input']);

function resolvePathFromEnv(varName: string, fallbackRelativePath: string): URL {
  const overridePath = process.env[varName]?.trim();
  if (overridePath) {
    return pathToFileURL(overridePath);
  }
  return new URL(fallbackRelativePath, import.meta.url);
}

export const LOG_PATH = resolvePathFromEnv('CULT_NEWS_LOG_PATH', '../last-run.log');
export const DRAFTS_PATH = resolvePathFromEnv('CULT_NEWS_DRAFTS_PATH', '../reports/last-run-drafts.json');
export const DRAFTS_ARCHIVE_PATH = resolvePathFromEnv('CULT_NEWS_DRAFTS_ARCHIVE_PATH', '../reports/drafts-archive.json');
export const OUTPUT_PATH = resolvePathFromEnv('CULT_NEWS_OUTPUT_PATH', '../reports/cult-news-latest.html');
export const SOURCES_OUTPUT_PATH = resolvePathFromEnv(
  'CULT_NEWS_SOURCES_PATH',
  '../reports/cult-news-sources.json',
);

function decodeLogText(value: string): string {
  return value
    .replace(/\\'/g, "'")
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_, hex, dec) =>
      String.fromCodePoint(hex ? parseInt(hex, 16) : parseInt(dec, 10))
    )
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, '\u00a0')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&ldquo;/gi, '\u201c')
    .replace(/&rdquo;/gi, '\u201d')
    .replace(/&hellip;/gi, '\u2026');
}

export function extractDraftsFromLog(logText: string): DraftStory[] {
  const lines = logText.split(/\r?\n/);
  const drafts: DraftStory[] = [];

  let inDraft = false;
  let braceDepth = 0;
  let inSourceBlock = false;
  let title = '';
  let sourceUrl = '';
  let sourceHost = '';
  let publishedAt = '';

  for (const line of lines) {
    if (!inDraft && line.startsWith('[agent] draft (dry-run) {')) {
      inDraft = true;
      braceDepth = 1;
      inSourceBlock = false;
      title = '';
      sourceUrl = '';
      sourceHost = '';
      publishedAt = '';
      continue;
    }

    if (!inDraft) {
      continue;
    }

    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;

    const titleMatch = line.match(/^\s*title:\s*(['"])(.*)\1,\s*$/);
    if (!title && titleMatch?.[2]) {
      title = decodeLogText(titleMatch[2]);
    }

    if (line.match(/^\s*source:\s*\{\s*$/)) {
      inSourceBlock = true;
    }

    if (inSourceBlock) {
      const urlMatch = line.match(/^\s*url:\s*(['"])(https?:\/\/[^'"]+)\1/);
      if (!sourceUrl && urlMatch?.[2]) {
        sourceUrl = urlMatch[2].trim();
      }

      const hostMatch = line.match(/^\s*host:\s*(['"])([^'"]+)\1/);
      if (!sourceHost && hostMatch?.[2]) {
        sourceHost = hostMatch[2].trim();
      }

      const publishedMatch = line.match(/^\s*publishedAt:\s*(['"])([^'"]+)\1/);
      if (!publishedAt && publishedMatch?.[2]) {
        publishedAt = publishedMatch[2].trim();
      }

      if (line.match(/^\s*\},?\s*$/)) {
        inSourceBlock = false;
      }
    }

    if (braceDepth <= 0) {
      if (title && sourceUrl) {
        drafts.push({
          title,
          url: sourceUrl,
          host: sourceHost,
          publishedAt: publishedAt || undefined,
        });
      }

      inDraft = false;
      braceDepth = 0;
      inSourceBlock = false;
    }
  }

  const unique = new Map<string, DraftStory>();
  for (const draft of drafts) {
    if (!unique.has(draft.url)) {
      unique.set(draft.url, draft);
    }
  }

  return Array.from(unique.values());
}

export function extractRunSummary(logText: string): RunSummary | undefined {
  const match = logText.match(/\[agent\] run summary \{([\s\S]*?)\n\}/m);
  if (!match?.[1]) {
    return undefined;
  }

  const summary: RunSummary = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim().replace(/,$/, '');
    const parts = line.match(/^([a-zA-Z][a-zA-Z0-9]*):\s*(-?\d+(?:\.\d+)?)$/);
    if (!parts) {
      continue;
    }

    const key = parts[1];
    if (!key) {
      continue;
    }

    summary[key] = Number(parts[2]);
  }

  return summary;
}

function hostFromUrl(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function shouldTryArchiveForHost(host: string | undefined): boolean {
  if (!host) return false;
  return Array.from(ARCHIVE_FALLBACK_HOSTS).some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

async function fetchHtmlFromUrl(fetchUrl: string): Promise<{ ok: boolean; html: string; finalUrl: string; status: number }> {
  const response = await fetchTextResilient(fetchUrl, {
    headers: {
      'User-Agent': HTTP_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
    },
  });

  return {
    ok: response.ok,
    html: response.text,
    finalUrl: response.url,
    status: response.status,
  };
}

function isUsableArticleText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 200 && !looksLikeBlockedFetchPage(trimmed);
}

function metaFromHtml(html: string): Omit<StoryMeta, 'contentMirrorUrl' | 'archiveMirrorLinks'> {
  const pageMeta = extractPageMetadataFromHtml(html);
  return {
    title: pageMeta.title,
    description: pageMeta.description,
    image: pageMeta.image,
    publishedAt: pageMeta.publishedAt,
    articleText: htmlToPlainArticleText(html),
    htmlLang: pageMeta.htmlLang,
  };
}

async function fetchBestArchiveHtml(
  canonicalUrl: string,
): Promise<{ html: string; finalUrl: string } | undefined> {
  const mirrorUrls = [
    `https://archive.ph/newest/${canonicalUrl}`,
    `https://archive.is/newest/${canonicalUrl}`,
  ];
  let best: { html: string; finalUrl: string; textLength: number } | undefined;

  for (const mirrorUrl of mirrorUrls) {
    const fetched = await fetchHtmlFromUrl(mirrorUrl);
    if (!fetched.ok) continue;
    const text = metaFromHtml(fetched.html).articleText ?? '';
    if (!isUsableArticleText(text)) continue;
    const textLength = text.length;
    if (!best || textLength > best.textLength) {
      best = { html: fetched.html, finalUrl: fetched.finalUrl, textLength };
    }
  }

  return best ? { html: best.html, finalUrl: best.finalUrl } : undefined;
}

export async function fetchStoryMeta(url: string, options?: { contentMirrorUrl?: string }): Promise<StoryMeta> {
  const canonicalUrl = getCanonicalArticleUrl(url);
  const host = hostFromUrl(canonicalUrl);
  const knownSnapshots = options?.contentMirrorUrl ? [options.contentMirrorUrl] : [];
  const mirrorLinks = () =>
    buildArchiveMirrorLinks(canonicalUrl, { knownSnapshotUrls: knownSnapshots });

  try {
    if (options?.contentMirrorUrl) {
      const mirrorFetch = await fetchHtmlFromUrl(options.contentMirrorUrl);
      const mirrorText = metaFromHtml(mirrorFetch.html).articleText ?? '';
      if (mirrorFetch.ok && isUsableArticleText(mirrorText)) {
        const meta = metaFromHtml(mirrorFetch.html);
        return {
          ...meta,
          contentMirrorUrl: mirrorFetch.finalUrl,
          archiveMirrorLinks: buildArchiveMirrorLinks(canonicalUrl, {
            knownSnapshotUrls: [mirrorFetch.finalUrl],
          }),
        };
      }
    }

    const direct = await fetchHtmlFromUrl(canonicalUrl);
    let html = direct.html;
    let contentMirrorUrl = options?.contentMirrorUrl;

    const directMeta = metaFromHtml(html);
    const directText = directMeta.articleText ?? '';
    const needsArchive =
      needsArchiveMirrorFallback(
        direct.ok,
        direct.status,
        directText,
        BROWSER_RENDER_FALLBACK_STATUS_CODES,
      ) || (shouldTryArchiveForHost(host) && !direct.ok);

    if (needsArchive) {
      const archiveFetch = await fetchBestArchiveHtml(canonicalUrl);
      if (archiveFetch) {
        const archiveMeta = metaFromHtml(archiveFetch.html);
        const archiveText = archiveMeta.articleText ?? '';
        if (
          !direct.ok ||
          !isUsableArticleText(directText) ||
          archiveText.length > directText.length + 400
        ) {
          html = archiveFetch.html;
          contentMirrorUrl = archiveFetch.finalUrl;
          knownSnapshots.length = 0;
          knownSnapshots.push(archiveFetch.finalUrl);
        }
      }
    }

    if (!html) {
      return { archiveMirrorLinks: mirrorLinks() };
    }

    const meta = metaFromHtml(html);
    return {
      ...meta,
      ...(contentMirrorUrl ? { contentMirrorUrl } : {}),
      archiveMirrorLinks: buildArchiveMirrorLinks(canonicalUrl, { knownSnapshotUrls: knownSnapshots }),
    };
  } catch {
    return { archiveMirrorLinks: mirrorLinks() };
  }
}

export function formatPublishedAt(value: string | undefined): string {
  if (!value) {
    return 'Unknown publication time';
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return 'Unknown publication time';
  }

  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}

export function h(
  tag: string | ((props: Record<string, unknown>) => Child),
  props: Record<string, unknown> | null,
  ...children: Child[]
): Child {
  const normalizedProps = props ?? {};
  const flatChildren = children.flat(Infinity as 1).filter((child) => child !== null && child !== undefined && child !== false);

  if (typeof tag === 'function') {
    return tag({ ...normalizedProps, children: flatChildren });
  }

  return {
    tag,
    props: normalizedProps,
    children: flatChildren as Array<VNode | string | number>,
  };
}

export function Fragment(props: { children?: Child | Child[] }): Child {
  return (props.children ?? '') as Child;
}

export function renderDocument(node: Child): string {
  return '<!doctype html>\n' + renderNode(node);
}

function renderNode(node: Child): string {
  if (node === null || node === undefined || node === false || node === true) {
    return '';
  }

  if (Array.isArray(node)) {
    return node.map((child) => renderNode(child)).join('');
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return escapeHtml(node);
  }

  const attrs: string[] = [];
  let rawInnerHtml: string | undefined;

  for (const [rawKey, value] of Object.entries(node.props)) {
    if (rawKey === 'dangerouslySetInnerHTML') {
      const dih = value as { __html?: string } | null;
      rawInnerHtml = dih?.__html ?? '';
      continue;
    }

    if (value === null || value === undefined || value === false) {
      continue;
    }

    const key = rawKey === 'className' ? 'class' : rawKey;
    if (value === true) {
      attrs.push(key);
      continue;
    }

    attrs.push(`${key}="${escapeHtml(value)}"`);
  }

  const attrText = attrs.length ? ` ${attrs.join(' ')}` : '';
  if (VOID_TAGS.has(node.tag)) {
    return `<${node.tag}${attrText}>`;
  }

  if (rawInnerHtml !== undefined) {
    return `<${node.tag}${attrText}>${rawInnerHtml}</${node.tag}>`;
  }

  const childText = node.children.map((child) => renderNode(child)).join('');
  return `<${node.tag}${attrText}>${childText}</${node.tag}>`;
}
