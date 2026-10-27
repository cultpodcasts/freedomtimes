// Post-build patches for the Cloudflare server bundle. Registry, statuses and reasons live in
// scripts/lib/cloudflare-bundle-patches.mjs. This step FAILS (exit 1) when a required patch target
// is missing or an obsolete patch's upstream bug reappears, instead of logging "patched 0 file(s)".
import fs from 'node:fs';
import path from 'node:path';

import { applyBundlePatches } from './lib/cloudflare-bundle-patches.mjs';

const serverDir = path.resolve('dist/server');

if (!fs.existsSync(serverDir)) {
	console.error('[patch-cloudflare-bundle] dist/server not found. Run astro build first.');
	process.exit(1);
}

function collectMjsFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectMjsFiles(fullPath));
		else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(fullPath);
	}
	return files;
}

function installedVersion(pkg: string): string | undefined {
	try {
		const json = JSON.parse(fs.readFileSync(path.resolve('node_modules', pkg, 'package.json'), 'utf8')) as { version?: string };
		return json.version;
	} catch {
		return undefined;
	}
}

const files = collectMjsFiles(serverDir).map((p) => ({ path: path.relative(process.cwd(), p), text: fs.readFileSync(p, 'utf8') }));
const versions: Record<string, string> = {};
for (const pkg of ['emdash', '@astrojs/cloudflare']) {
	const v = installedVersion(pkg);
	if (v) versions[pkg] = v;
}

const { files: out, results, errors } = applyBundlePatches(files, versions);

let patched = 0;
for (const f of out) {
	if (f.changed) {
		fs.writeFileSync(path.resolve(f.path), f.text, 'utf8');
		patched += 1;
	}
}

for (const r of results) {
	if (r.status === 'required') {
		console.log(`[patch-cloudflare-bundle] required ${r.id}: matched=${r.matched} present=${r.present} ${r.ok ? 'OK' : 'MISSING'}`);
	} else {
		console.log(`[patch-cloudflare-bundle] obsolete ${r.id}: ${r.ok ? 'still obsolete' : 'NEEDS REVIEW'}`);
	}
}
console.log(`[patch-cloudflare-bundle] patched ${patched} file(s) (emdash ${versions.emdash ?? '?'}, @astrojs/cloudflare ${versions['@astrojs/cloudflare'] ?? '?'})`);

if (errors.length > 0) {
	for (const e of errors) console.error(`[patch-cloudflare-bundle] ERROR ${e}`);
	process.exit(1);
}
