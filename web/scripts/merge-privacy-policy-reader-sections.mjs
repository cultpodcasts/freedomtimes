/**
 * One-off: merge Story tips + Turnstile + notification sections into privacy-policy page.
 * Usage: node web/scripts/merge-privacy-policy-reader-sections.mjs [--url <origin>] <backup-json-path>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emdashMcpToolsCall } from "./emdash-mcp-client.mjs";

const STAGING = "https://staging.freedomtimes.news";
const PROD = "https://freedomtimes.news";

function loadAuth() {
	return JSON.parse(readFileSync(join(homedir(), ".config", "emdash", "auth.json"), "utf8"));
}

function resolveToken(baseUrl) {
	const u = baseUrl.replace(/\/$/, "");
	const envTok = process.env.EMDASH_MCP_TOKEN?.trim();
	if (envTok) return envTok;
	if (u === STAGING) {
		const t =
			process.env.EMDASH_STAGING_TOKEN?.trim() ??
			process.env.EMDASH_STAGING_PAT?.trim();
		if (t) return t;
	}
	if (u === PROD) {
		const t =
			process.env.EMDASH_PRODUCTION_TOKEN?.trim() ??
			process.env.EMDASH_PRODUCTION_PAT?.trim();
		if (t) return t;
	}
	const auth = loadAuth();
	const t = auth[u]?.accessToken;
	if (!t) throw new Error(`No token for ${u}`);
	return t;
}

let keySeq = 0;
function key() {
	return `pp${(++keySeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function span(text, marks = []) {
	return { _type: "span", _key: key(), text, marks };
}

function block(style, children, extra = {}) {
	const b = { _type: "block", _key: key(), style, children };
	if (extra.listItem) {
		b.listItem = extra.listItem;
		b.level = extra.level ?? 1;
	}
	if (extra.markDefs) b.markDefs = extra.markDefs;
	return b;
}

function h2(text) {
	return block("h2", [span(text)]);
}

function para(children) {
	return block("normal", children);
}

function strongLine(text) {
	return block("normal", [span(text, ["strong"])]);
}

function bullet(children) {
	return block("normal", children, { listItem: "bullet", level: 1 });
}

function linkPara(parts) {
	const markDefs = [];
	const children = [];
	for (const part of parts) {
		if (typeof part === "string") {
			children.push(span(part));
			continue;
		}
		const mk = key();
		markDefs.push({
			_type: "link",
			_key: mk,
			href: part.href,
			blank: part.blank ?? true,
		});
		children.push(span(part.text, [mk]));
	}
	return block("normal", children, markDefs.length ? { markDefs } : {});
}

function readerSubmissionSections() {
	return [
		h2("Story tips (/submit-a-tip)"),
		para([span("When you submit a story tip:")]),
		strongLine("What Freedom Times stores"),
		bullet([
			span("Anonymous (default):", ["strong"]),
			span(
				" your tip text and when you sent it. We do not save your name, email, IP address, or account details.",
			),
		]),
		bullet([
			span("With contact details:", ["strong"]),
			span(
				" your tip text plus the name and email you provide so we can follow up.",
			),
		]),
		bullet([
			span("Retention:", ["strong"]),
			span(
				" tips are kept for editorial review and deleted on request where applicable (contact privacy@freedomtimes.news).",
			),
		]),
		strongLine("What Cloudflare does for the bot check"),
		linkPara([
			"Before your tip reaches us, ",
			{
				text: "Cloudflare Turnstile",
				href: "https://www.cloudflare.com/en-gb/application-services/products/turnstile/",
			},
			" runs a spam check on Cloudflare's systems using technical browser signals (such as IP address, browser type, and connection details). We do not receive or store those signals. Cloudflare says it uses them only to tell humans from bots — not to identify you or show you ads. See Cloudflare's ",
			{
				text: "Turnstile privacy addendum",
				href: "https://www.cloudflare.com/turnstile-privacy-policy/",
			},
			".",
		]),
		para([
			span(
				"For GDPR, third-party roles, lawful bases, and how to exercise your rights, see ",
			),
			span("Third-party services (Cloudflare Turnstile)", ["strong"]),
			span(" below."),
		]),
		linkPara([
			"You can verify the handler source code linked from ",
			{ text: "/tip-source", href: "/tip-source", blank: false },
			".",
		]),
		h2("Third-party services (Cloudflare Turnstile)"),
		para([
			span(
				"We use Cloudflare Turnstile on /submit-a-tip to block automated spam before tips reach our editorial team.",
			),
		]),
		strongLine("Roles"),
		bullet([
			span("Freedom Times (data controller):", ["strong"]),
			span(
				" we decide why and how your tip is processed. For the Turnstile bot check, Cloudflare acts as our data processor — it handles browser signals on our instructions, solely to detect bots.",
			),
		]),
		(() => {
			const mk = key();
			return block(
				"normal",
				[
					span("Cloudflare (also data controller):", ["strong"]),
					span(
						" Cloudflare separately processes the same signals to improve Turnstile's bot detection. This is described in Cloudflare's ",
					),
					span("Turnstile privacy addendum", [mk]),
					span("."),
				],
				{
					listItem: "bullet",
					level: 1,
					markDefs: [
						{
							_type: "link",
							_key: mk,
							href: "https://www.cloudflare.com/turnstile-privacy-policy/",
							blank: true,
						},
					],
				},
			);
		})(),
		strongLine("What Cloudflare collects"),
		para([
			span(
				"When you complete the check, Cloudflare processes technical signals such as your IP address, TLS fingerprint, browser user-agent, site key, and the site you are visiting. Cloudflare states it cannot directly identify individuals from these signals and does not use them to identify, profile, or target you.",
			),
		]),
		strongLine("Lawful basis (EU and UK residents)"),
		bullet([
			span("For bot detection on our behalf, we rely on our ", ["strong"]),
			span("legitimate interest", ["strong"]),
			span(
				" in protecting our submission form from abuse. As controller, we determine the lawful basis; Cloudflare processes on our instructions.",
			),
		]),
		bullet([
			span("For improving Turnstile, Cloudflare relies on its ", ["strong"]),
			span("legitimate interests", ["strong"]),
			span(
				" in maintaining effective bot detection (see the addendum, section 5).",
			),
		]),
		strongLine("International transfers"),
		linkPara([
			"Processing may involve transfers outside your country. Safeguards and further detail are in Cloudflare's ",
			{
				text: "privacy policy",
				href: "https://www.cloudflare.com/privacypolicy/",
			},
			" and the ",
			{
				text: "Turnstile privacy addendum",
				href: "https://www.cloudflare.com/turnstile-privacy-policy/",
			},
			".",
		]),
		strongLine("Your rights"),
		bullet([
			span(
				"To exercise data protection rights relating to Turnstile on our site, contact ",
			),
			span("privacy@freedomtimes.news", ["strong"]),
			span(
				". Cloudflare directs visitors to contact the website operator (us) for processor-related requests.",
			),
		]),
		bullet([
			span(
				"For Cloudflare's own processing as controller, you may also contact Cloudflare's Data Protection Officer at ",
			),
			span("dpo@cloudflare.com", ["strong"]),
			span("."),
		]),
		h2('Notification troubleshooting ("Report a problem")'),
		para([span("When you send a diagnostic report from the notification callout:")]),
		bullet([
			span(
				"We store a sanitized technical snapshot (browser family, OS family, notification permission state, service worker status, whether a push subscription exists, push service hostname only if subscribed, page path, and optional note you type).",
			),
		]),
		bullet([
			span(
				"We do not store your IP address, email, account details, raw user agent string, full push subscription URL, or cryptographic keys.",
			),
		]),
		bullet([
			span(
				"Reports are used only to debug notification delivery issues.",
			),
		]),
		para([
			span(
				"Story tips use a dedicated tips database. Notification diagnostic reports are stored in the subscriptions database alongside push subscription records (same Worker secrets: TURSO_SUBSCRIPTIONS_*).",
			),
		]),
	];
}

function mergeContent(existingContent) {
	const marker = "Changes to this policy";
	const idx = existingContent.findIndex(
		(b) =>
			b.style === "h2" &&
			b.children?.[0]?.text === marker,
	);
	if (idx < 0) throw new Error(`Could not find "${marker}" heading`);
	const already = existingContent.some((b) =>
		b.children?.[0]?.text?.startsWith("Story tips"),
	);
	if (already) {
		console.error("Story tips section already present — skipping merge");
		return null;
	}
	const newSections = readerSubmissionSections();
	return [
		...existingContent.slice(0, idx),
		...newSections,
		...existingContent.slice(idx),
	];
}

function parseArgs(argv) {
	let url = STAGING;
	const rest = [];
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === "--url" && argv[i + 1]) {
			url = argv[++i].replace(/\/$/, "");
			continue;
		}
		rest.push(argv[i]);
	}
	const backupPath = rest[0];
	if (!backupPath)
		throw new Error(
			"Usage: node merge-privacy-policy-reader-sections.mjs [--url <origin>] <backup-json>",
		);
	return { url, backupPath };
}

async function main() {
	const { url, backupPath } = parseArgs(process.argv);
	const snapshot = JSON.parse(readFileSync(backupPath, "utf8"));
	const { item, _rev } = snapshot;
	const merged = mergeContent(item.data.content);
	if (!merged) {
		console.log(JSON.stringify({ ok: true, skipped: true, url }, null, 2));
		return;
	}
	const data = { ...item.data, content: merged };
	const token = resolveToken(url);
	const out = await emdashMcpToolsCall(url, token, "content_update", {
		collection: "pages",
		id: "privacy-policy",
		data,
		_rev: String(_rev),
	});
	console.log(
		JSON.stringify(
			{
				ok: true,
				url,
				_rev_used: _rev,
				_rev_after: out._rev ?? null,
				status: item.status,
				blocks_added: merged.length - item.data.content.length,
				preview: `${url}/privacy-policy`,
			},
			null,
			2,
		),
	);
}

main().catch((e) => {
	console.error(e?.message ?? e);
	process.exit(1);
});
