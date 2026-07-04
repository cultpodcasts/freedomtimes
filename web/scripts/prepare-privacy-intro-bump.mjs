/**
 * Local prep only — builds content_update JSON for privacy-policy intro date bump.
 * Usage: node web/scripts/prepare-privacy-intro-bump.mjs <staging|production>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const env = process.argv[2];
if (!env || !["staging", "production"].includes(env)) {
	console.error("Usage: node prepare-privacy-intro-bump.mjs <staging|production>");
	process.exit(1);
}

const snapshotPath = join(repoRoot, `_tmp-privacy-policy-${env}-snapshot.json`);
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const backupPath = join(repoRoot, `_tmp-privacy-policy-${env}-backup.json`);
writeFileSync(backupPath, JSON.stringify(snapshot, null, 2));

const { item, _rev } = snapshot;
let content = item.data.content;

if (typeof content === "string") {
	content = content.replace(
		"This policy was updated May 9, 2026",
		"This policy was updated 4 July 2026",
	);
} else if (Array.isArray(content)) {
	content = content.map((block) => {
		const text = block.children?.[0]?.text;
		if (text?.startsWith("This policy was updated")) {
			return {
				...block,
				children: [{ ...block.children[0], text: "This policy was updated 4 July 2026" }],
			};
		}
		return block;
	});
} else {
	throw new Error("Unexpected content shape");
}

const payload = {
	collection: "pages",
	id: "privacy-policy",
	_rev: String(_rev),
	data: { content },
};

const outPath = join(repoRoot, `_tmp-privacy-update-${env}.json`);
writeFileSync(outPath, JSON.stringify(payload));
console.log(JSON.stringify({ env, backupPath, outPath, rev: _rev, status: item.status }, null, 2));
