// Registry of post-build patches applied to the Cloudflare server bundle (web/dist/server).
//
// Every patch has an explicit status:
//   - "required": the target MUST be found (exactly `expectMatches` times across the bundle) and
//     rewritten. If it is missing the build fails, because a silent "patched 0 file(s)" means the
//     upstream code moved and the fix is no longer shipping.
//   - "obsolete": fixed upstream / code path removed. Not applied. Each obsolete entry is pinned to
//     the package range it was verified against and carries a `regressionNeedle`: if the old buggy
//     code reappears in the bundle, or the installed package is outside the verified range, the
//     build fails so a human re-checks the patch instead of shipping a silent no-op.
//
// Pure functions only (no fs), so scripts/test-cloudflare-bundle-patches.mts can exercise them.

/** @typedef {{ name: string, version: string }} InstalledPackage */

const PUBLISH_ERROR_PATTERN =
	/(console\.error\("Content publish error:", error\);\s*return\s*\{\s*success:\s*false,\s*error:\s*\{\s*code:\s*"CONTENT_PUBLISH_ERROR",\s*message:\s*)"Failed to publish content"/g;

export const BUNDLE_PATCHES = [
	{
		id: 'publish-error-diagnostics',
		status: 'required',
		description:
			'EmDash content publish handler returns a bare "Failed to publish content"; append the caught error message so MCP/admin publish failures are diagnosable.',
		pattern: PUBLISH_ERROR_PATTERN,
		replace: (_match, prefix) =>
			`${prefix}\`Failed to publish content: \${error instanceof Error ? error.message : String(error)}\``,
		// Marker proving the patch is in place (idempotent re-runs count as applied).
		appliedMarker: 'Failed to publish content: ${error instanceof Error ? error.message : String(error)}',
		expectMatches: 1,
	},
	{
		id: 'oauth-csrf-cookie-path',
		status: 'obsolete',
		package: 'emdash',
		verifiedRange: { min: '1.3.1', belowMinor: '1.5' },
		reason:
			'Upstream sets the CSRF cookie with Path=/_emdash/oauth/authorize (the real route); the /_emdash/api/... path bug is gone.',
		regressionNeedle: 'Path=/_emdash/api/oauth/authorize',
	},
	{
		id: 'baseline-security-headers-writable-response',
		status: 'obsolete',
		package: 'emdash',
		verifiedRange: { min: '1.3.1', belowMinor: '1.5' },
		reason:
			'setBaselineSecurityHeaders() no longer exists; emdash middleware finalizeResponse() clones via new Response(response.body, response) before setting headers.',
		regressionNeedle: 'function setBaselineSecurityHeaders(response)',
	},
	{
		id: 'publish-syncdatacolumns-drift-guard',
		status: 'obsolete',
		package: 'emdash',
		verifiedRange: { min: '1.3.1', belowMinor: '1.5' },
		reason:
			'Publish no longer calls syncDataColumns(); it filters revision data with keepKnownFields(revision.data, writableFieldSlugs), so dropped columns cannot cause "no such column".',
		regressionNeedle: 'await this.syncDataColumns(type, id, revision.data)',
	},
	{
		id: 'worker-entry-assets-guard',
		status: 'obsolete',
		package: '@astrojs/cloudflare',
		verifiedRange: { min: '14.0.0', belowMinor: '15.0' },
		reason:
			'@astrojs/cloudflare 14 removed the worker-entry_ chunk (static assets go through matchStaticAsset/fallbackToAssets in entry.mjs). The guard only mattered when ASSETS was unbound; ASSETS is bound by assets.binding in web/wrangler.jsonc (checked by verify-worker-placement.mjs).',
		regressionNeedle: 'if (app.manifest.assets.has(requestPathname)) {',
	},
	{
		id: 'create-require-import-meta-url',
		status: 'obsolete',
		package: 'emdash',
		verifiedRange: { min: '1.3.1', belowMinor: '1.5' },
		reason:
			'No server chunk calls createRequire(import.meta.url); the only occurrence is the build-time integration (emdash/dist/astro/index.mjs), handled by scripts/patch-emdash-windows-createrequire.mjs.',
		regressionNeedle: 'createRequire(import.meta.url)',
	},
];

function parseVersion(v) {
	const [major, minor, patch] = String(v)
		.split(/[.+-]/)
		.map((n) => Number.parseInt(n, 10));
	return [major || 0, minor || 0, patch || 0];
}

/** True when `version` is >= range.min and < range.belowMinor (major.minor). */
export function versionInRange(version, range) {
	const [maj, min, pat] = parseVersion(version);
	const [lo1, lo2, lo3] = parseVersion(range.min);
	const [hi1, hi2] = parseVersion(range.belowMinor);
	const geMin = maj > lo1 || (maj === lo1 && (min > lo2 || (min === lo2 && pat >= lo3)));
	const ltMax = maj < hi1 || (maj === hi1 && min < hi2);
	return geMin && ltMax;
}

/**
 * Apply all patches to an in-memory bundle.
 * @param {Array<{ path: string, text: string }>} files
 * @param {Record<string, string>} installedVersions package name -> version
 * @param {typeof BUNDLE_PATCHES} [patches]
 */
export function applyBundlePatches(files, installedVersions, patches = BUNDLE_PATCHES) {
	const out = files.map((f) => ({ ...f, changed: false }));
	const results = [];
	const errors = [];

	for (const patch of patches) {
		if (patch.status === 'required') {
			let matches = 0;
			let alreadyApplied = 0;
			for (const f of out) {
				const re = new RegExp(patch.pattern.source, patch.pattern.flags.includes('g') ? patch.pattern.flags : `${patch.pattern.flags}g`);
				const found = f.text.match(re);
				if (found) {
					matches += found.length;
					f.text = f.text.replace(re, patch.replace);
					f.changed = true;
				}
				if (patch.appliedMarker) {
					alreadyApplied += f.text.split(patch.appliedMarker).length - 1;
				}
			}
			// alreadyApplied counts both freshly patched and pre-patched occurrences.
			const ok = alreadyApplied === patch.expectMatches;
			results.push({ id: patch.id, status: 'required', matched: matches, present: alreadyApplied, ok });
			if (!ok) {
				errors.push(
					`required patch "${patch.id}" expected ${patch.expectMatches} target(s) in dist/server but found ${alreadyApplied} (fresh matches: ${matches}). The upstream code moved: update the pattern in scripts/lib/cloudflare-bundle-patches.mjs, or mark it obsolete with a reason if upstream fixed it.`,
				);
			}
			continue;
		}

		if (patch.status === 'obsolete') {
			const installed = installedVersions[patch.package];
			const hits = out.filter((f) => f.text.includes(patch.regressionNeedle)).map((f) => f.path);
			let ok = true;
			if (!installed) {
				ok = false;
				errors.push(`obsolete patch "${patch.id}": package ${patch.package} is not installed; cannot confirm it is still obsolete.`);
			} else if (!versionInRange(installed, patch.verifiedRange)) {
				ok = false;
				errors.push(
					`obsolete patch "${patch.id}" was verified for ${patch.package} >=${patch.verifiedRange.min} <${patch.verifiedRange.belowMinor} but ${installed} is installed. Re-check (${patch.reason}) and widen verifiedRange.`,
				);
			}
			if (hits.length > 0) {
				ok = false;
				errors.push(
					`obsolete patch "${patch.id}": the old upstream code reappeared in ${hits.join(', ')}. Restore the patch as "required".`,
				);
			}
			results.push({ id: patch.id, status: 'obsolete', ok, regressionHits: hits.length });
			continue;
		}

		errors.push(`patch "${patch.id}" has unknown status "${patch.status}"`);
	}

	return { files: out, results, errors };
}
