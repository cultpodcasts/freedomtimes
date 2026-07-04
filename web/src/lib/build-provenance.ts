import { readOptionalEnv } from './auth';

/** GitHub org/repo slug, e.g. cultpodcasts/freedomtimes */
export const GITHUB_REPOSITORY = readOptionalEnv('GITHUB_REPOSITORY').trim() || 'cultpodcasts/freedomtimes';

/** Full commit SHA baked in at deploy time (GitHub Actions `github.sha` or local `git rev-parse HEAD`). */
export const BUILD_COMMIT_SHA = readOptionalEnv('FT_BUILD_COMMIT_SHA').trim() || 'unknown';

/** True when the build ran from a dirty working tree (local deploys only). */
export const BUILD_TREE_DIRTY = readOptionalEnv('FT_BUILD_TREE_DIRTY').trim() === '1';

const GITHUB_HOST = 'https://github.com';

export function isKnownCommitSha(sha: string = BUILD_COMMIT_SHA): boolean {
  return sha !== 'unknown' && sha.length >= 7;
}

/** Short commit label for UI (GitHub default: 7 hex chars). Links still use the full SHA. */
export function formatShortCommitSha(
  sha: string = BUILD_COMMIT_SHA,
  length = 7,
): string {
  if (!isKnownCommitSha(sha)) {
    return 'unknown';
  }
  return sha.slice(0, length);
}

/** Story tip handler files for public verification at the deployed commit. */
export const STORY_TIP_HANDLER_SOURCE_PATHS = [
  'web/src/pages/submit-a-tip.astro',
  'web/src/pages/api/story-tips.ts',
  'web/src/lib/story-tips.ts',
  'web/src/lib/tips-db.ts',
  'web/src/lib/turnstile.ts',
] as const;

/** Source files linked for public verification of reader submission handlers. */
export const READER_SUBMISSION_SOURCE_PATHS = [
  ...STORY_TIP_HANDLER_SOURCE_PATHS,
  'web/src/lib/subscriptions-db.ts',
  'infra/subscriptions-database/migrations/20260702_create_notification_diagnostics.sql',
  'infra/subscriptions-database/migrations/20260703_add_push_reader_test_sent_at.sql',
  'infra/subscriptions-database/migrations/20260704_add_notification_diagnostics_status.sql',
  'infra/subscriptions-database/migrations/20260705_rename_notification_diagnostics_status_values.sql',
  'web/src/pages/tip-source.astro',
  'web/src/pages/api/tip-source.json.ts',
  'web/src/pages/api/notification-diagnostics.ts',
  'web/src/pages/api/push-test-notification.ts',
  'web/src/lib/notification-diagnostics.ts',
  'web/src/lib/notification-diagnostics-server.ts',
  'web/src/lib/push-test-notification-server.ts',
  'web/src/lib/push-test-throttle.ts',
  'web/src/components/PushNotificationsCallout.astro',
] as const;

/** @deprecated Use READER_SUBMISSION_SOURCE_PATHS */
export const STORY_TIP_SOURCE_PATHS = READER_SUBMISSION_SOURCE_PATHS;

export function githubCommitUrl(commitSha: string = BUILD_COMMIT_SHA): string | null {
  if (!isKnownCommitSha(commitSha)) {
    return null;
  }
  return `${GITHUB_HOST}/${GITHUB_REPOSITORY}/commit/${commitSha}`;
}

export function githubTreeUrl(
  filePath: string,
  commitSha: string = BUILD_COMMIT_SHA,
): string | null {
  if (!isKnownCommitSha(commitSha)) {
    return null;
  }
  return `${GITHUB_HOST}/${GITHUB_REPOSITORY}/tree/${commitSha}/${filePath}`;
}

export function githubBlobUrl(
  filePath: string,
  commitSha: string = BUILD_COMMIT_SHA,
): string | null {
  if (!isKnownCommitSha(commitSha)) {
    return null;
  }
  return `${GITHUB_HOST}/${GITHUB_REPOSITORY}/blob/${commitSha}/${filePath}`;
}

function mapSourceFiles(paths: readonly string[]) {
  return paths.map((path) => ({
    path,
    treeUrl: githubTreeUrl(path),
    blobUrl: githubBlobUrl(path),
  }));
}

export function buildVersionPayload() {
  return {
    repository: GITHUB_REPOSITORY,
    commitSha: BUILD_COMMIT_SHA,
    shortSha: formatShortCommitSha(),
    commitUrl: githubCommitUrl(),
  };
}

export function buildProvenancePayload() {
  return {
    ...buildVersionPayload(),
    sourceFiles: mapSourceFiles(READER_SUBMISSION_SOURCE_PATHS),
    storyTipHandlerFiles: mapSourceFiles(STORY_TIP_HANDLER_SOURCE_PATHS),
    verifiedAt: new Date().toISOString(),
  };
}
