// node --test scripts/ci-check-no-public-backups.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
	findTrackedFileViolations,
	findWorkflowViolations,
	isForbiddenStoredPath,
} from "./ci-check-no-public-backups.mjs";

test("forbidden artifact/cache paths", () => {
	for (const p of [
		".release/backups/emdash-production-20260101.db",
		"web/*.db",
		"dump.sql",
		"out/data.sqlite",
		".release/backups/",
		"production-backup.tar",
		"db-dump/",
		".",
		"**",
		".release",
		".release/**",
		"'./x.db'",
	]) {
		assert.equal(isForbiddenStoredPath(p), true, p);
	}
	for (const p of [
		"web/android/app/build/outputs/apk/debug/*.apk",
		".release/rollback-branches/20260101-x.json",
		"${{ steps.emdash_backup.outputs.rollback_metadata }}",
		"~/.npm",
		"",
	]) {
		assert.equal(isForbiddenStoredPath(p), false, p);
	}
});

test("upload-artifact with a .db path fails (inline and block)", () => {
	const inline = `
jobs:
  a:
    steps:
      - name: Upload
        uses: actions/upload-artifact@v4
        with:
          name: backup
          path: .release/backups/x.db
`;
	const block = `
jobs:
  a:
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: |
            web/dist/report.txt
            web/data/live.sqlite
      - run: echo ok
`;
	assert.equal(findWorkflowViolations(inline).length, 1);
	const found = findWorkflowViolations(block);
	assert.equal(found.length, 1);
	assert.match(found[0].text, /live\.sqlite/);
});

test("actions/cache of a backup dir fails; setup-node npm cache is fine", () => {
	const yml = `
    steps:
      - uses: actions/setup-node@v4
        with:
          cache: npm
      - uses: actions/cache@v4
        with:
          key: k
          path: .release/backups
`;
	const found = findWorkflowViolations(yml);
	assert.equal(found.length, 1);
	assert.match(found[0].why, /actions\/cache/);
});

test("safe uploads and paths in other steps pass", () => {
	const yml = `
    steps:
      - uses: actions/upload-artifact@v4
        with:
          path: web/android/app/build/outputs/apk/debug/*.apk
      - name: Not an upload
        run: ls .release/backups
        with:
          path: x.db
`;
	assert.deepEqual(findWorkflowViolations(yml), []);
});

test("export/dump commands and summaries fail; comments do not", () => {
	assert.equal(findWorkflowViolations("        run: turso db export freedomtimes-emdash-production").length, 1);
	assert.equal(findWorkflowViolations("          turso db shell x .dump > out.sql").length, 1);
	assert.equal(findWorkflowViolations("          cat .release/backups/x.json >> $GITHUB_STEP_SUMMARY").length, 1);
	assert.equal(findWorkflowViolations("          Get-Content web/x.db").length, 1);
	assert.deepEqual(findWorkflowViolations("      # never run turso db export in CI"), []);
});

test("tracked files", () => {
	const bad = findTrackedFileViolations([
		".release/backups/emdash-production-1.db",
		".release/backups/export-staging-emdash.sh",
		".release/backups/rows.json",
		"infra/tips-database/migrations/20260702_create_story_tips.sql",
		"infra/scheduler-database/seeds/x.sql",
		"web/dump.sql",
		".release/rollback-branches/x.json",
		"web/src/x.ts",
	]).map((v) => v.path);
	assert.deepEqual(bad, [".release/backups/emdash-production-1.db", ".release/backups/rows.json", "web/dump.sql"]);
});
