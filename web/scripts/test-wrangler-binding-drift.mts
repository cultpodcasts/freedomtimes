/**
 * Binding drift guard (PR #118 review). Deploys use web/wrangler.jsonc, NOT the
 * adapter-generated dist/server/wrangler.json, so any binding the adapter
 * expects must be named in wrangler.jsonc for every deployed env, or be
 * allow-listed here with a reason. Local only — never wire into CI.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseJsonc } from './lib/worker-placement-check.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(webDir, 'package.json'));
// The adapter's exports map blocks deep imports; resolve the package dir and import by file URL.
const adapterDir = dirname(require.resolve('@astrojs/cloudflare/package.json'));
const adapterFile = (rel: string) => join(adapterDir, 'dist', rel);

type Cfg = Record<string, any>;
const readJsonc = (p: string): Cfg => parseJsonc(readFileSync(p, 'utf8'));
const deployCfg = readJsonc(join(webDir, 'wrangler.jsonc'));
const buildCfg = readJsonc(join(webDir, 'wrangler.build.jsonc'));
const DEPLOYED_ENVS = ['production', 'staging'];

/**
 * Bindings the adapter may add that we intentionally do NOT bind.
 * Each entry must say why and what covers the gap.
 */
const ALLOW_UNBOUND: Record<string, string> = {
	IMAGES:
		'Cloudflare Images binding — not bound because transforms are billed; binding it is Jon\'s decision. ' +
		'EmDash media /_image serves the R2 original without it; other /_image hrefs are served by ' +
		'src/lib/image-endpoint-guard.ts (middleware) instead of the throwing adapter transform endpoint.',
};

/** Binding names declared in one (non-inherited) config block. */
function bindingNames(block: Cfg | undefined): Set<string> {
	const names = new Set<string>();
	if (!block) return names;
	const add = (v: unknown) => typeof v === 'string' && v && names.add(v);
	for (const key of [
		'kv_namespaces',
		'r2_buckets',
		'd1_databases',
		'analytics_engine_datasets',
		'services',
		'queues',
		'hyperdrive',
		'vectorize',
	]) {
		const list = key === 'queues' ? block.queues?.producers : block[key];
		for (const b of Array.isArray(list) ? list : []) add(b.binding);
	}
	for (const b of Array.isArray(block.send_email) ? block.send_email : []) add(b.name);
	for (const b of block.durable_objects?.bindings ?? []) add(b.name);
	add(block.images?.binding);
	add(block.ai?.binding);
	add(block.browser?.binding);
	add(block.assets?.binding);
	return names;
}

/** Effective bindings of a deployed env: env block + inheritable top-level keys (assets). */
function effectiveEnvBindings(envName: string): Set<string> {
	const env = deployCfg.env?.[envName];
	assert.ok(env, `wrangler.jsonc env.${envName} exists`);
	const names = bindingNames(env);
	if (!env.assets && deployCfg.assets?.binding) names.add(deployCfg.assets.binding);
	return names;
}

function assertBound(source: string, required: Iterable<string>) {
	for (const envName of DEPLOYED_ENVS) {
		const have = effectiveEnvBindings(envName);
		for (const name of required) {
			if (have.has(name)) continue;
			assert.ok(
				ALLOW_UNBOUND[name],
				`${source} binding "${name}" is missing from wrangler.jsonc env.${envName} ` +
					'and not in ALLOW_UNBOUND (add it to wrangler.jsonc, or allow-list it with a reason)',
			);
		}
	}
}

describe('wrangler binding drift (adapter vs deploy config)', () => {
	it('assets: binding ASSETS, directory dist/client, env overrides keep the binding', () => {
		assert.equal(deployCfg.assets?.binding, 'ASSETS');
		assert.equal(deployCfg.assets?.directory, 'dist/client');
		for (const [envName, env] of Object.entries<Cfg>(deployCfg.env ?? {})) {
			if (env.assets) {
				assert.equal(env.assets.binding, 'ASSETS', `env.${envName}.assets overrides top-level; keep binding ASSETS`);
			}
		}
		for (const envName of DEPLOYED_ENVS) {
			assert.ok(effectiveEnvBindings(envName).has('ASSETS'), `env.${envName} gets ASSETS`);
		}
	});

	it('adapter binding names and runtime uses are unchanged (ASSETS / IMAGES)', async () => {
		const wrangler = await import(pathToFileURL(adapterFile('wrangler.js')).href);
		assert.equal(wrangler.DEFAULT_ASSETS_BINDING_NAME, 'ASSETS');
		assert.equal(wrangler.DEFAULT_IMAGES_BINDING_NAME, 'IMAGES');
		assert.equal(wrangler.DEFAULT_SESSION_KV_BINDING_NAME, 'SESSION');
		const cfHelpers = readFileSync(adapterFile('utils/cf-helpers.js'), 'utf8');
		assert.match(cfHelpers, /env\.ASSETS\.fetch\(/, 'utils/cf-helpers.js still serves fallbacks via env.ASSETS.fetch');
		const transformEndpoint = readFileSync(adapterFile('entrypoints/image-transform-endpoint.js'), 'utf8');
		assert.match(transformEndpoint, /env\.IMAGES/, 'image-transform-endpoint still uses env.IMAGES (see ALLOW_UNBOUND.IMAGES)');
		const passthrough = readFileSync(adapterFile('entrypoints/image-passthrough-endpoint.js'), 'utf8');
		assert.match(passthrough, /env\.ASSETS\.fetch\(/, 'image-passthrough-endpoint (used by the /_image guard) uses ASSETS only');
		assert.doesNotMatch(passthrough, /IMAGES/);
	});

	it('every binding the adapter customizer adds is bound in wrangler.jsonc or allow-listed', async () => {
		const { cloudflareConfigCustomizer } = await import(pathToFileURL(adapterFile('wrangler.js')).href);
		// Same options the adapter uses for this repo: KV sessions + default cloudflare-binding image service.
		const added = cloudflareConfigCustomizer({ needsSessionKVBinding: true, imagesBindingName: 'IMAGES' })(buildCfg);
		const names = bindingNames(added);
		assert.ok(names.has('ASSETS'), 'adapter adds ASSETS (wrangler.build.jsonc has no assets)');
		assert.ok(names.has('SESSION'));
		assertBound('adapter customizer', names);
	});

	it('every binding in the generated dist/server/wrangler.json is bound or allow-listed', (t) => {
		const generated = join(webDir, 'dist/server/wrangler.json');
		if (!existsSync(generated)) {
			t.skip('dist/server/wrangler.json not built — run npm run build to include this check');
			return;
		}
		const cfg = JSON.parse(readFileSync(generated, 'utf8'));
		assert.equal(cfg.assets?.binding, 'ASSETS');
		assertBound('dist/server/wrangler.json', bindingNames(cfg));
	});

	it('allow-list entries all carry a reason and are not actually bound', () => {
		for (const [name, reason] of Object.entries(ALLOW_UNBOUND)) {
			assert.ok(reason.length > 40, `${name} has a reason`);
			for (const envName of DEPLOYED_ENVS) {
				assert.ok(
					!effectiveEnvBindings(envName).has(name),
					`${name} is now bound in env.${envName}; remove it from ALLOW_UNBOUND (and revisit the /_image guard)`,
				);
			}
		}
	});
});
