import type { EnrichedStory } from './render-cult-news-html.helpers.ts';
import { getDigestExclusionReason, detectStoryLanguage } from './render-cult-news-html.tsx';
import {
  findStoryByPattern,
  loadStoriesFromRegressionFixture,
  matchesPattern,
  type RegressionFixture,
} from './clusterTestLib.ts';

export type DigestExclusionSpec = {
  id: string;
  storyPattern: string;
  reasonPattern?: string;
};

export type DigestExclusionExpectations = {
  _description?: string;
  mustIncludeFromDigest?: DigestExclusionSpec[];
  mustExcludeFromDigest: DigestExclusionSpec[];
};

export type DigestSnippetFixture = {
  snippets: Array<{
    id: string;
    title: string;
    url: string;
    host?: string;
    description?: string;
    articleText?: string;
  }>;
};

export function snippetToStory(row: DigestSnippetFixture['snippets'][number]): EnrichedStory {
  return {
    title: row.title ?? '',
    url: row.url ?? '',
    host: row.host,
    description: row.description ?? '',
    articleText: row.articleText ?? '',
  };
}

export function resolveExclusionStory(
  spec: DigestExclusionSpec,
  clusterFixture: RegressionFixture | null,
  snippetFixture: DigestSnippetFixture | null,
): EnrichedStory | undefined {
  const snippet = snippetFixture?.snippets.find((row) => row.id === spec.id);
  if (snippet) {
    return snippetToStory(snippet);
  }
  if (clusterFixture) {
    return findStoryByPattern(loadStoriesFromRegressionFixture(clusterFixture), spec.storyPattern);
  }
  return undefined;
}

export function assertMustExcludeFromDigest(
  specs: DigestExclusionSpec[],
  clusterFixture: RegressionFixture | null,
  snippetFixture: DigestSnippetFixture | null,
): string[] {
  const failures: string[] = [];

  for (const spec of specs) {
    const story = resolveExclusionStory(spec, clusterFixture, snippetFixture);
    if (!story) {
      console.log(`  ○ ${spec.id}: skipped (story not in fixtures)`);
      continue;
    }

    const language = detectStoryLanguage(story);
    const reason = getDigestExclusionReason(story, language);
    if (!reason) {
      failures.push(
        `[${spec.id}] "${spec.storyPattern}" should be excluded from digest but getDigestExclusionReason returned undefined`,
      );
      continue;
    }

    if (spec.reasonPattern) {
      const reasonRe = new RegExp(spec.reasonPattern, 'i');
      if (!reasonRe.test(reason)) {
        failures.push(
          `[${spec.id}] exclusion reason "${reason}" does not match /${spec.reasonPattern}/i`,
        );
        continue;
      }
    }

    console.log(`  ✓ ${spec.id}: excluded — ${reason.slice(0, 72)}`);
  }

  return failures;
}

export function assertMustIncludeInDigest(
  specs: DigestExclusionSpec[],
  clusterFixture: RegressionFixture | null,
  snippetFixture: DigestSnippetFixture | null,
): string[] {
  const failures: string[] = [];

  for (const spec of specs) {
    const story = resolveExclusionStory(spec, clusterFixture, snippetFixture);
    if (!story) {
      console.log(`  ○ ${spec.id}: skipped (story not in fixtures)`);
      continue;
    }

    const language = detectStoryLanguage(story);
    const reason = getDigestExclusionReason(story, language);
    if (reason) {
      failures.push(
        `[${spec.id}] "${spec.storyPattern}" should stay in digest but getDigestExclusionReason returned: ${reason}`,
      );
      continue;
    }

    console.log(`  ✓ ${spec.id}: kept in digest (figurative genre, substantive cult subject)`);
  }

  return failures;
}

export function assertMustNotAppearInRenderCorpus(
  specs: DigestExclusionSpec[],
  corpusStories: EnrichedStory[],
): string[] {
  const failures: string[] = [];

  for (const spec of specs) {
    const hit = corpusStories.find((story) => matchesPattern(story, spec.storyPattern));
    if (hit) {
      failures.push(
        `[${spec.id}] "${spec.storyPattern}" must not appear in render corpus but was kept (${hit.url})`,
      );
      continue;
    }
    console.log(`  ✓ ${spec.id}: not in render corpus`);
  }

  return failures;
}
