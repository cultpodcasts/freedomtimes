import { readOptionalEnv } from './auth';

/** GitHub org/repo slug, e.g. cultpodcasts/freedomtimes */
export const GITHUB_REPOSITORY = readOptionalEnv('GITHUB_REPOSITORY').trim() || 'cultpodcasts/freedomtimes';

/** Full commit SHA baked in at deploy time (GitHub Actions `github.sha`). */
export const BUILD_COMMIT_SHA = readOptionalEnv('FT_BUILD_COMMIT_SHA').trim() || 'unknown';

const GITHUB_HOST = 'https://github.com';

/** Source files linked for public verification of reader submission handlers. */
export const READER_SUBMISSION_SOURCE_PATHS = [
  'web/src/pages/submit-a-tip.astro',
  'web/src/pages/api/story-tips.ts',
  'web/src/lib/story-tips.ts',
  'web/src/lib/tips-db.ts',
  'web/src/lib/subscriptions-db.ts',
  'infra/subscriptions-database/migrations/20260702_create_notification_diagnostics.sql',
  'infra/subscriptions-database/migrations/20260703_add_push_reader_test_sent_at.sql',
  'web/src/pages/tip-source.astro',
  'web/src/pages/api/tip-source.json.ts',
  'web/src/pages/api/notification-diagnostics.ts',
  'web/src/pages/api/push-test-notification.ts',
  'web/src/lib/notification-diagnostics.ts',
  'web/src/lib/notification-diagnostics-server.ts',
  'web/src/lib/push-test-notification-server.ts',
  'web/src/lib/push-test-throttle.ts',
  'web/src/lib/turnstile.ts',
  'web/src/components/PushNotificationsCallout.astro',
] as const;

/** @deprecated Use READER_SUBMISSION_SOURCE_PATHS */
export const STORY_TIP_SOURCE_PATHS = READER_SUBMISSION_SOURCE_PATHS;

export function githubCommitUrl(commitSha: string = BUILD_COMMIT_SHA): string {
  return `${GITHUB_HOST}/${GITHUB_REPOSITORY}/commit/${commitSha}`;
}

export function githubTreeUrl(
  filePath: string,
  commitSha: string = BUILD_COMMIT_SHA,
): string {
  return `${GITHUB_HOST}/${GITHUB_REPOSITORY}/tree/${commitSha}/${filePath}`;
}

export function githubBlobUrl(
  filePath: string,
  commitSha: string = BUILD_COMMIT_SHA,
): string {
  return `${GITHUB_HOST}/${GITHUB_REPOSITORY}/blob/${commitSha}/${filePath}`;
}

export function buildVersionPayload() {
  return {
    repository: GITHUB_REPOSITORY,
    commitSha: BUILD_COMMIT_SHA,
    commitUrl: githubCommitUrl(),
  };
}

export function buildProvenancePayload() {
  return {
    ...buildVersionPayload(),
    sourceFiles: READER_SUBMISSION_SOURCE_PATHS.map((path) => ({
      path,
      treeUrl: githubTreeUrl(path),
      blobUrl: githubBlobUrl(path),
    })),
    verifiedAt: new Date().toISOString(),
  };
}
