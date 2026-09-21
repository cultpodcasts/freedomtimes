/**
 * Rewrite Source Notes that dump local working-tree paths into reader-facing links.
 *
 * - Replace `media/...` / bare filename paths with helpful link labels → EmDash media URLs
 * - Strip `*.md` working-document citations
 * - Keep published exhibits (books, dates, people) as plain text
 */

const MEDIA = (key) => `/_emdash/api/media/file/${key}`;

/** Local path (or basename) → { href, label } for the public exhibit. */
const PATH_LINKS = new Map([
	[
		'media/documents/_web/readable/B1-concordance-04-05-readable-rot90ccw.jpg',
		{ href: MEDIA('01M2NCMM7MB2FKC6HY7R901YGP.jpg'), label: 'concordance pp. 4–5' },
	],
	[
		'B1-concordance-04-05-readable-rot90ccw.jpg',
		{ href: MEDIA('01M2NCMM7MB2FKC6HY7R901YGP.jpg'), label: 'concordance pp. 4–5' },
	],
	[
		'Background/Lance-WhatsApp/aberdeen-concordance-pages-06-07.jpeg',
		{ href: MEDIA('aberdeen-concordance-pages-06-07.jpeg'), label: 'concordance pp. 6–7' },
	],
	[
		'aberdeen-concordance-pages-06-07.jpeg',
		{ href: MEDIA('aberdeen-concordance-pages-06-07.jpeg'), label: 'concordance pp. 6–7' },
	],
	[
		'aberdeen-concordance-pages-08-09.jpeg',
		{ href: MEDIA('aberdeen-concordance-pages-08-09.jpeg'), label: 'concordance pp. 8–9' },
	],
	[
		'media/pamphlet/S3-destroy-order.png',
		{ href: MEDIA('01M2NCMCZ6BDNXMJJXNMQB47T2.jpg'), label: 'destroy-order cover' },
	],
	[
		'S3-destroy-order.png',
		{ href: MEDIA('01M2NCMCZ6BDNXMJJXNMQB47T2.jpg'), label: 'destroy-order cover' },
	],
	[
		'media/pamphlet/S4-intro-100pct.png',
		{ href: MEDIA('01M2NCMDNG33ABYHK1EX29VBFJ.jpg'), label: 'pamphlet p. 58' },
	],
	[
		'S4-intro-100pct.png',
		{ href: MEDIA('01M2NCMDNG33ABYHK1EX29VBFJ.jpg'), label: 'pamphlet p. 58' },
	],
	[
		'media/pamphlet/S5-brighton-100pct.png',
		{ href: MEDIA('01M2NCMED1RA5QKYFJ6G8PJ3TE.jpg'), label: 'pamphlet p. 60 (Brighton)' },
	],
	[
		'S5-brighton-100pct.png',
		{ href: MEDIA('01M2NCMED1RA5QKYFJ6G8PJ3TE.jpg'), label: 'pamphlet p. 60 (Brighton)' },
	],
	[
		'media/tape-highlights/SOURCE_STATUS.md',
		{ drop: true },
	],
	[
		'transcripts/pamphlet-verified-quotes.md',
		{ drop: true },
	],
]);

function isPathish(text) {
	const t = String(text || '').trim();
	if (!t) return false;
	if (PATH_LINKS.has(t)) return true;
	if (/\.md$/i.test(t)) return true;
	if (/^(media\/|Background\/|transcripts\/)/i.test(t)) return true;
	if (/^[A-Za-z0-9._-]+\.(jpe?g|png|gif|webp|pdf|mp3|mp4|vtt|md)$/i.test(t)) return true;
	return false;
}

function lookup(text) {
	const t = String(text || '').trim();
	if (PATH_LINKS.has(t)) return PATH_LINKS.get(t);
	if (/\.md$/i.test(t)) return { drop: true };
	return null;
}

function newKey(prefix) {
	return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

function blockText(block) {
	const kids = Array.isArray(block?.children) ? block.children : [];
	return kids.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('');
}

function needsRewrite(block) {
	if (!block || block._type !== 'block') return false;
	const kids = Array.isArray(block.children) ? block.children : [];
	if (kids.some((c) => isPathish(c?.text))) return true;
	const t = blockText(block);
	if (
		/media\/documents|media\/pamphlet|media\/tape-highlights|media\/press\/|SOURCE_STATUS\.md|pamphlet-verified-quotes\.md|page-checked |pamphlet quotes? P\d/i.test(
			t,
		) || /Image:\s*media\//i.test(t)
	) {
		return true;
	}
	// Fix prior bad rewrite: three concordance labels all pointed at pp. 4–5 ULID
	if (/Bruce-era concordance/i.test(t) && /concordance pp\. 6–7/i.test(t)) {
		const defs = Array.isArray(block.markDefs) ? block.markDefs : [];
		const hrefs = defs
			.filter((d) => d?._type === 'link')
			.map((d) => String(d.href || ''));
		const wrongShared =
			hrefs.filter((h) => h.includes('01M2NCMM7MB2FKC6HY7R901YGP')).length >= 2;
		const missingDistinct =
			!hrefs.some((h) => h.includes('aberdeen-concordance-pages-06-07')) ||
			!hrefs.some((h) => h.includes('aberdeen-concordance-pages-08-09'));
		if (wrongShared || missingDistinct) return true;
	}
	return false;
}

/**
 * Rebuild children for known Source Notes shapes.
 * Falls back to span-by-span path replacement when the whole note is unrecognized.
 */
function rewriteNote(block) {
	const text = blockText(block);
	const markDefs = Array.isArray(block.markDefs) ? [...block.markDefs] : [];
	const addLink = (href) => {
		const key = newKey('cite');
		markDefs.push({ _type: 'link', _key: key, href });
		return key;
	};

	/** @type {object[]|null} */
	let children = null;
	let kind = 'span-path-replace';

	if (/Bruce-era concordance/i.test(text) && /concordance pp\.|B1-concordance|aberdeen-concordance/i.test(text)) {
		kind = 'note-concordance';
		const a = addLink(MEDIA('01M2NCMM7MB2FKC6HY7R901YGP.jpg'));
		const b = addLink(MEDIA('aberdeen-concordance-pages-06-07.jpeg'));
		const c = addLink(MEDIA('aberdeen-concordance-pages-08-09.jpeg'));
		children = [
			{
				_type: 'span',
				_key: newKey('k'),
				text: 'Bruce-era concordance (Bible and Gospel Trust subject index, vols. 1–130, ministry of B. D. Hales). “a lie against a holy man of God”; “caught up in the stupidity” (',
			},
			{ _type: 'span', _key: newKey('k'), text: 'concordance pp. 4–5', marks: [a] },
			{
				_type: 'span',
				_key: newKey('k'),
				text: '). “completely unsubstantial, unwitnessed, unsubstantiated, false”: ',
			},
			{ _type: 'span', _key: newKey('k'), text: 'concordance pp. 6–7', marks: [b] },
			{ _type: 'span', _key: newKey('k'), text: '. Heading ' },
			{ _type: 'span', _key: newKey('k'), text: 'ABERDEEN—test of', marks: ['em'] },
			{ _type: 'span', _key: newKey('k'), text: ': ' },
			{ _type: 'span', _key: newKey('k'), text: 'concordance pp. 8–9', marks: [c] },
			{ _type: 'span', _key: newKey('k'), text: '.' },
		];
	} else if (/SOURCE_STATUS\.md|Hall highlights video/i.test(text)) {
		kind = 'note-hall-audio';
		const existing =
			markDefs.find((m) => m?._type === 'link' && String(m.href || '').includes('01M2DNJ293BCY92Z2MBE8Z8B32'))
			?? null;
		const audioKey = existing?._key ?? addLink(MEDIA('01M2DNJ293BCY92Z2MBE8Z8B32.mp3'));
		children = [
			{
				_type: 'span',
				_key: newKey('k'),
				text: 'Hall highlights video with English captions. Full Saturday afternoon meeting (archival length, ~76 minutes): ',
			},
			{ _type: 'span', _key: newKey('k'), text: 'Listen to the full meeting', marks: [audioKey] },
			{ _type: 'span', _key: newKey('k'), text: '.' },
		];
	} else if (/Destroy-order cover note/i.test(text)) {
		kind = 'note-destroy-order';
		const link = addLink(MEDIA('01M2NCMCZ6BDNXMJJXNMQB47T2.jpg'));
		children = [
			{ _type: 'span', _key: newKey('k'), text: 'Destroy-order cover note: ' },
			{ _type: 'span', _key: newKey('k'), text: 'If We Walk in the Light', marks: ['em'] },
			{ _type: 'span', _key: newKey('k'), text: ' (1970) — ' },
			{ _type: 'span', _key: newKey('k'), text: 'view destroy-order cover', marks: [link] },
			{ _type: 'span', _key: newKey('k'), text: '.' },
		];
	} else if (/Stott intro, printed/i.test(text) && /S4-intro|100% support/i.test(text)) {
		kind = 'note-pamphlet-58';
		const link = addLink(MEDIA('01M2NCMDNG33ABYHK1EX29VBFJ.jpg'));
		children = [
			{
				_type: 'span',
				_key: newKey('k'),
				text: 'Stott intro, printed p. 58: 100% support; Maynard upper garment; Storr against enquiry — ',
			},
			{ _type: 'span', _key: newKey('k'), text: 'view pamphlet page', marks: [link] },
			{ _type: 'span', _key: newKey('k'), text: '.' },
		];
	} else if (/Brighton inquisition/i.test(text)) {
		kind = 'note-pamphlet-60';
		const link = addLink(MEDIA('01M2NCMED1RA5QKYFJ6G8PJ3TE.jpg'));
		children = [
			{
				_type: 'span',
				_key: newKey('k'),
				text: 'Brighton inquisition, printed p. 60: “Are you 100% with J.T.Jr.”?; “J.T.Jr. is the issue.” — ',
			},
			{ _type: 'span', _key: newKey('k'), text: 'view pamphlet page', marks: [link] },
			{ _type: 'span', _key: newKey('k'), text: '.' },
		];
	} else if (/Finn Daily Express 18 Aug/i.test(text) || /Image:\s*media\/press/i.test(text)) {
		kind = 'note-daily-express';
		const link = addLink(MEDIA('01M2NCMG978X8CYC8XX4EZY1D1.jpg'));
		children = [
			{
				_type: 'span',
				_key: newKey('k'),
				text: 'Finn Daily Express 18 Aug (whisky, arm, pure person, nothing happened): Adams Ch. XV; TC §3 — ',
			},
			{ _type: 'span', _key: newKey('k'), text: 'Daily Express, 18 Aug 1970', marks: [link] },
			{ _type: 'span', _key: newKey('k'), text: '.' },
		];
	} else {
		// Generic: replace pathish spans; drop .md; tidy leftover "page-checked " / "JPEG: "
		const nextKids = [];
		for (const span of block.children || []) {
			const raw = typeof span?.text === 'string' ? span.text : '';
			const info = lookup(raw);
			if (info?.drop) continue;
			if (info?.href && info.label) {
				const key = addLink(info.href);
				nextKids.push({
					_type: 'span',
					_key: newKey('k'),
					text: info.label,
					marks: [key],
				});
				continue;
			}
			let cleaned = raw
				.replace(/\bpage-checked\s+/gi, '')
				.replace(/\bJPEG:\s*/gi, '')
				.replace(/;\s*pamphlet quotes?\s+P[\d–-]+/gi, '')
				.replace(/\s*P1\.\s*$/g, '.')
				.replace(/\(\s*\)/g, '')
				.replace(/\s{2,}/g, ' ');
			if (!cleaned) continue;
			nextKids.push({ ...span, text: cleaned });
		}
		children = nextKids;
	}

	// Drop orphaned markDefs that are no longer referenced
	const used = new Set();
	for (const span of children) {
		for (const m of span.marks || []) used.add(m);
	}
	const nextDefs = markDefs.filter((d) => used.has(d._key));

	return {
		block: {
			...block,
			children,
			...(nextDefs.length ? { markDefs: nextDefs } : { markDefs: undefined }),
		},
		kind,
	};
}

export function transformCitationReaderLinksBlock(block, index) {
	if (!needsRewrite(block)) {
		return { block, change: null };
	}
	const beforeText = blockText(block);
	const beforeHrefs = (Array.isArray(block.markDefs) ? block.markDefs : [])
		.filter((d) => d?._type === 'link')
		.map((d) => String(d.href || ''))
		.join('|');
	const { block: after, kind } = rewriteNote(block);
	const afterText = blockText(after);
	const afterHrefs = (Array.isArray(after.markDefs) ? after.markDefs : [])
		.filter((d) => d?._type === 'link')
		.map((d) => String(d.href || ''))
		.join('|');
	if (beforeText === afterText && beforeHrefs === afterHrefs) {
		return { block, change: null };
	}
	return {
		block: after,
		change: {
			index,
			transform: 'citation-reader-links',
			kind,
			before: { _type: 'block', text: beforeText.slice(0, 160), hrefs: beforeHrefs.slice(0, 200) },
			after: { _type: 'block', text: afterText.slice(0, 160), hrefs: afterHrefs.slice(0, 200) },
		},
	};
}

export const citationReaderLinksTransform = {
	id: 'citation-reader-links',
	description:
		'Source Notes: replace disk/media paths with reader links; drop .md working-doc citations',
	matches(block) {
		return needsRewrite(block);
	},
	transform: transformCitationReaderLinksBlock,
};
