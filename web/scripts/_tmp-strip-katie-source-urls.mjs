/**
 * Remove visible URL spans from ks-s1..ks-s7; keep link marks on titles; end with "." only.
 * Args: path to MCP content_get JSON
 * Writes: web/.tmp/katie-sources-no-plain-urls.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const slug =
	"building-the-cult-what-katie-simpsons-murder-reveals-about-coercive-control-group-dynamics-and-the-laws-that-should-have-saved-her";

const inPath = process.argv[2];
if (!inPath) {
	console.error("Usage: node _tmp-strip-katie-source-urls.mjs <content_get.json>");
	process.exit(1);
}

function stripKsBlock(block) {
	const k = block._key;
	if (!/^ks-s[1-7]$/.test(k)) return block;
	const children = [];
	for (const c of block.children ?? []) {
		const key = c._key ?? "";
		if (/-u2?$/.test(key) || key.endsWith("-sp")) continue;
		if (key.endsWith("-u1")) continue;
		if (key.endsWith("-u")) continue;
		if (key.endsWith("-d")) {
			children.push({ ...c, text: "." });
			continue;
		}
		children.push(c);
	}
	return { ...block, children };
}

const j = JSON.parse(readFileSync(inPath, "utf8"));
const content = j.item.data.content.map((b) => stripKsBlock(b));

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp");
const outPath = join(outDir, "katie-sources-no-plain-urls.json");
const payload = {
	collection: "posts",
	id: slug,
	data: { content },
	_rev: j._rev,
};
writeFileSync(outPath, JSON.stringify(payload), "utf8");
console.log("Wrote", outPath);
