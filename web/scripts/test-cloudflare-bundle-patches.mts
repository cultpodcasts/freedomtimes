import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUNDLE_PATCHES, applyBundlePatches, versionInRange } from './lib/cloudflare-bundle-patches.mjs';

const OK_VERSIONS = { emdash: '1.4.0', '@astrojs/cloudflare': '14.4.3' };

// Shape of emdash 1.3.1 dist (tab-indented) — the old space-indented needle never matched this.
const PUBLISH_CATCH = [
	'\t} catch (error) {',
	'\t\tconsole.error("Content publish error:", error);',
	'\t\treturn {',
	'\t\t\tsuccess: false,',
	'\t\t\terror: {',
	'\t\t\t\tcode: "CONTENT_PUBLISH_ERROR",',
	'\t\t\t\tmessage: "Failed to publish content"',
	'\t\t\t}',
	'\t\t};',
	'\t}',
].join('\n');

const bundle = (extra = '') => [
	{ path: 'dist/server/chunks/api.mjs', text: `function a(){\n${PUBLISH_CATCH}\n}\n${extra}` },
	// i18n catalogue containing the same English string must not count as a target.
	{ path: 'dist/server/chunks/messages.mjs', text: 'const m = {"Failed to publish content":"Failed to publish content"};' },
];

describe('cloudflare bundle patches', () => {
	it('applies publish-error-diagnostics to the tab-indented 1.3.1 shape', () => {
		const r = applyBundlePatches(bundle(), OK_VERSIONS);
		assert.deepEqual(r.errors, []);
		const api = r.files[0];
		assert.equal(api.changed, true);
		assert.match(api.text, /message: `Failed to publish content: \$\{error instanceof Error \? error\.message : String\(error\)\}`/);
		assert.equal(r.files[1].changed, false);
	});

	it('matches space-indented / minified shapes too', () => {
		const minified =
			'catch(error){console.error("Content publish error:", error);return{success:false,error:{code:"CONTENT_PUBLISH_ERROR",message:"Failed to publish content"}}}';
		const r = applyBundlePatches([{ path: 'x.mjs', text: minified }], OK_VERSIONS);
		assert.deepEqual(r.errors, []);
		assert.equal(r.files[0].changed, true);
	});

	it('is idempotent (re-running on a patched bundle is OK and changes nothing)', () => {
		const first = applyBundlePatches(bundle(), OK_VERSIONS);
		const second = applyBundlePatches(first.files.map(({ path, text }) => ({ path, text })), OK_VERSIONS);
		assert.deepEqual(second.errors, []);
		assert.equal(second.files.some((f) => f.changed), false);
	});

	it('FAILS loudly when a required target is missing (upstream code moved)', () => {
		const r = applyBundlePatches([{ path: 'x.mjs', text: 'return { message: "Something else" }' }], OK_VERSIONS);
		assert.equal(r.errors.length, 1);
		assert.match(r.errors[0], /required patch "publish-error-diagnostics" expected 1 target\(s\).*found 0/);
	});

	it('FAILS when the required target appears more than expected', () => {
		const r = applyBundlePatches([{ path: 'x.mjs', text: `${PUBLISH_CATCH}\n${PUBLISH_CATCH}` }], OK_VERSIONS);
		assert.match(r.errors.join('\n'), /expected 1 target\(s\).*found 2/);
	});

	it('FAILS when an obsolete patch\'s old upstream bug reappears', () => {
		const r = applyBundlePatches(bundle('document.cookie="x; Path=/_emdash/api/oauth/authorize"'), OK_VERSIONS);
		assert.match(r.errors.join('\n'), /obsolete patch "oauth-csrf-cookie-path": the old upstream code reappeared/);
	});

	it('FAILS when installed package is outside the range an obsolete patch was verified for', () => {
		const r = applyBundlePatches(bundle(), { emdash: '1.5.0', '@astrojs/cloudflare': '14.4.3' });
		assert.match(r.errors.join('\n'), /verified for emdash >=1\.3\.1 <1\.5 but 1\.5\.0 is installed/);
		const r2 = applyBundlePatches(bundle(), { emdash: '1.4.0' });
		assert.match(r2.errors.join('\n'), /@astrojs\/cloudflare is not installed/);
	});

	it('every patch declares a status and, if obsolete, a reason + regression needle + range', () => {
		for (const p of BUNDLE_PATCHES) {
			assert.ok(['required', 'obsolete'].includes(p.status), p.id);
			if (p.status === 'obsolete') {
				assert.ok(p.reason && p.regressionNeedle && p.verifiedRange && p.package, p.id);
			}
		}
	});

	it('versionInRange', () => {
		assert.equal(versionInRange('1.3.1', { min: '1.3.1', belowMinor: '1.4' }), true);
		assert.equal(versionInRange('1.3.9', { min: '1.3.1', belowMinor: '1.4' }), true);
		assert.equal(versionInRange('1.3.0', { min: '1.3.1', belowMinor: '1.4' }), false);
		assert.equal(versionInRange('1.4.0', { min: '1.3.1', belowMinor: '1.4' }), false);
		assert.equal(versionInRange('14.4.2', { min: '14.0.0', belowMinor: '15.0' }), true);
	});
});
