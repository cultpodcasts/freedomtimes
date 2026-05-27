/// <reference types="node" />
import { pathToFileURL } from 'node:url';

export type DraftStory = {
  title: string;
  url: string;
  host?: string;
  publishedAt?: string;
  classificationAudit?: CultClassificationAudit;
};

export type StoryMeta = {
  title?: string;
  description?: string;
  image?: string;
  publishedAt?: string;
  articleText?: string;
  htmlLang?: string;
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

function getMetaContent(html: string, key: string, type: 'property' | 'name'): string | undefined {
  const attr = type === 'property' ? 'property' : 'name';
  const pattern = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const match = html.match(pattern);
  return match?.[1]?.trim();
}

function normalizeIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function extractArticleText(html: string): string {
  const articleLikeHtml =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    html;

  return decodeHtmlEntities(
    articleLikeHtml
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(nav|footer|aside|form|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, 6000);
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

    summary[parts[1]] = Number(parts[2]);
  }

  return summary;
}

export async function fetchStoryMeta(url: string): Promise<StoryMeta> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'FreedomTimes-Local-Agent/0.1',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return {};
    }

    const html = await response.text();

    const htmlLang = html.match(/<html[^>]+lang=["']([^"']+)["'][^>]*>/i)?.[1]?.trim() ?? undefined;

    const title =
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
    );

    return {
      title: title ? decodeHtmlEntities(title) : undefined,
      description: description ? decodeHtmlEntities(description) : undefined,
      image,
      publishedAt,
      articleText: extractArticleText(html),
      htmlLang,
    };
  } catch {
    return {};
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
