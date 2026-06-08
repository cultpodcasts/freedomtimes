/**
 * Patches ks-s2 / ks-s3 prefix spans: date (dd Mmm yyyy) before duration [hh:mm:ss].
 * Input: path to MCP content_get JSON file.
 * Output: web/.tmp/katie-youtube-sources-update.json for content_update.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const slug =
	"building-the-cult-what-katie-simpsons-murder-reveals-about-coercive-control-group-dynamics-and-the-laws-that-should-have-saved-her";

const KS2_PREFIX = "Crime World, Nicola Tallant, 28 Dec 2025 [0:34:45]: ";
const KS3_PREFIX = "Crime World, Jenny Friel & Nuala Lappin, 07 May 2026 [0:47:57]: ";

const inPath = process.argv[2];
if (!inPath) {
	console.error("Usage: node _tmp-patch-katie-youtube-prefixes.mjs <content_get.json>");
	process.exit(1);
}

const j = JSON.parse(readFileSync(inPath, "utf8"));
const content = structuredClone(j.item.data.content);

for (const b of content) {
	if (b._key === "ks-s2") {
		const p = b.children?.find((c) => c._key === "ks-s2-p");
		if (p) p.text = KS2_PREFIX;
	}
	if (b._key === "ks-s3") {
		const p = b.children?.find((c) => c._key === "ks-s3-p");
		if (p) p.text = KS3_PREFIX;
	}
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp");
const outPath = join(outDir, "katie-youtube-sources-update.json");
const payload = {
	collection: "posts",
	id: slug,
	data: { content },
	_rev: j._rev,
};
writeFileSync(outPath, JSON.stringify(payload), "utf8");
console.log("Wrote", outPath, "bytes", Buffer.byteLength(JSON.stringify(payload)));
