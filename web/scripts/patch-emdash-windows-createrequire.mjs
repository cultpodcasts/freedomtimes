/**
 * EmDash 0.37 ships `createRequire("file:///emdash-registry-verification.js")`,
 * which Node on Windows rejects (not an absolute file URL). Patch before Astro load.
 * No-op when the needle is absent (Linux CI / fixed upstream).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(fileURLToPath(new URL("..", import.meta.url)), "node_modules", "emdash", "dist");
const needle = 'createRequire("file:///emdash-registry-verification.js")';
const replacement = "createRequire(import.meta.url)";

let patched = 0;
for (const name of readdirSync(dist)) {
	if (!name.endsWith(".mjs")) continue;
	const path = join(dist, name);
	const text = readFileSync(path, "utf8");
	if (!text.includes(needle)) continue;
	writeFileSync(path, text.replaceAll(needle, replacement));
	patched += 1;
	console.log(`[patch-emdash-windows-createrequire] patched ${name}`);
}
if (patched === 0) {
	console.log("[patch-emdash-windows-createrequire] no-op (needle absent)");
}
