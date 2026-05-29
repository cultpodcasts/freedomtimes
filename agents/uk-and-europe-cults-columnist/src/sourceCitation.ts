import { readFileSync } from 'node:fs';
import {
  buildArchiveMirrorLinks,
  looksLikePartialPaywall,
  type ArchiveMirrorLink,
} from './archiveMirrors.ts';
import { ARCHIVE_FALLBACK_HOSTS } from './http-cache/config.ts';

export type StoryCitationInput = {
  title: string;
  url: string;
  host?: string;
  publisher?: string;
  publishedAt?: string;
  articleText?: string;
  contentMirrorUrl?: string;
  archiveMirrorLinks?: ArchiveMirrorLink[];
};

export type StorySourceCitation = {
  title: string;
  publisher: string;
  publisherUrl: string;
  publishedAt?: string;
  paywalled: boolean;
  /** Best URL to link when the publisher page requires a subscription. */
  accessibleUrl?: string;
  alternativeUrls: ArchiveMirrorLink[];
  markdown: string;
};

export type CitationReport = {
  generatedAt: string;
  groups: Array<{
    label: string;
    type: 'detected' | 'independent';
    sources: StorySourceCitation[];
  }>;
  markdown: string;
};

function loadPublisherDisplayNames(): Record<string, string> {
  try {
    const fileUrl = new URL('../data/publisher-display-names.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf-8')) as Record<string, string>;
    return parsed;
  } catch {
    return {};
  }
}

const PUBLISHER_DISPLAY_NAMES = loadPublisherDisplayNames();

function hostFromInput(input: StoryCitationInput): string {
  if (input.host) {
    return input.host.toLowerCase().replace(/^www\./, '');
  }
  try {
    return new URL(input.url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function publisherLabel(input: StoryCitationInput): string {
  if (input.publisher?.trim()) {
    return input.publisher.trim();
  }
  const host = hostFromInput(input);
  return PUBLISHER_DISPLAY_NAMES[host] ?? host;
}

function isPaywallHost(host: string): boolean {
  return Array.from(ARCHIVE_FALLBACK_HOSTS).some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

function isSnapshotMirrorUrl(url: string): boolean {
  return !url.includes('/newest/') && !url.includes('/web/*/');
}

export function isLikelyPaywalledStory(input: StoryCitationInput): boolean {
  if (input.contentMirrorUrl && isSnapshotMirrorUrl(input.contentMirrorUrl)) {
    return true;
  }
  const host = hostFromInput(input);
  if (isPaywallHost(host)) {
    return true;
  }
  if (input.articleText && looksLikePartialPaywall(input.articleText)) {
    return true;
  }
  return false;
}

export function pickAccessibleUrl(
  input: StoryCitationInput,
  mirrors: ArchiveMirrorLink[],
): string | undefined {
  if (input.contentMirrorUrl && isSnapshotMirrorUrl(input.contentMirrorUrl)) {
    return input.contentMirrorUrl;
  }

  const savedSnapshot = mirrors.find((mirror) => isSnapshotMirrorUrl(mirror.href));
  if (savedSnapshot) {
    return savedSnapshot.href;
  }

  if (!isLikelyPaywalledStory(input)) {
    return undefined;
  }

  return (
    mirrors.find((mirror) => mirror.label === 'archive.ph')?.href ??
    mirrors.find((mirror) => mirror.href.includes('/newest/'))?.href
  );
}

function formatCitationDate(publishedAt: string | undefined): string | undefined {
  if (!publishedAt) return undefined;
  const date = new Date(publishedAt);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleDateString('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
}

export function formatStoryCitationMarkdown(citation: StorySourceCitation): string {
  const dateSuffix = citation.publishedAt ? `, ${formatCitationDate(citation.publishedAt)}` : '';
  const lines = [`- **${citation.title}** — ${citation.publisher}${dateSuffix}`];
  lines.push(`  Original: ${citation.publisherUrl}`);

  if (citation.paywalled) {
    if (citation.accessibleUrl) {
      lines.push(`  Accessible copy: ${citation.accessibleUrl}`);
    }
    const otherMirrors = citation.alternativeUrls
      .filter((mirror) => mirror.href !== citation.accessibleUrl)
      .map((mirror) => `${mirror.label}: ${mirror.href}`);
    if (otherMirrors.length > 0) {
      lines.push(`  Other mirrors: ${otherMirrors.join(' · ')}`);
    }
  }

  return lines.join('\n');
}

export function buildStorySourceCitation(input: StoryCitationInput): StorySourceCitation {
  const publisher = publisherLabel(input);
  const alternativeUrls =
    input.archiveMirrorLinks ??
    buildArchiveMirrorLinks(input.url, {
      knownSnapshotUrls: input.contentMirrorUrl ? [input.contentMirrorUrl] : [],
    });
  const paywalled = isLikelyPaywalledStory(input);
  const accessibleUrl = pickAccessibleUrl(input, alternativeUrls);
  const citation: StorySourceCitation = {
    title: input.title,
    publisher,
    publisherUrl: input.url,
    publishedAt: input.publishedAt,
    paywalled,
    accessibleUrl,
    alternativeUrls,
    markdown: '',
  };
  citation.markdown = formatStoryCitationMarkdown(citation);
  return citation;
}

export function buildCitationReport(
  groups: Array<{
    label: string;
    type: 'detected' | 'independent';
    stories: StoryCitationInput[];
  }>,
  generatedAt: string,
): CitationReport {
  const reportGroups = groups.map((group) => {
    const sources = group.stories.map((story) => buildStorySourceCitation(story));
    return {
      label: group.label,
      type: group.type,
      sources,
    };
  });

  const markdownSections = reportGroups.map((group) => {
    const heading =
      group.type === 'independent' ? '## Latest Stories' : `## ${group.label}`;
    const body = group.sources.map((source) => source.markdown).join('\n');
    return `${heading}\n\n${body}`;
  });

  return {
    generatedAt,
    groups: reportGroups,
    markdown: `# Source citations\n\nGenerated ${generatedAt}\n\n${markdownSections.join('\n\n')}`,
  };
}
