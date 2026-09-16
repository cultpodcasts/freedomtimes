/**
 * Source Notes cleanup for reader-facing citations:
 * - strip editorial / draft direction
 * - point pamphlet & letter citations at PDF exhibits (not extracted page images)
 */

const MEDIA = (key) => `/_emdash/api/media/file/${key}`;

const PDF = {
	walkLight: MEDIA('if-we-walk-in-the-light-robert-stott-1970.pdf'),
	gardinerMcCallum: MEDIA('gardiner-mccallum-letter-1970.pdf'),
	hindle: MEDIA('jt-jr-hindle-letter-1970.pdf'),
	steedman: MEDIA('01KZ8YQ6K3S20J9MXNF5FQRS2F.pdf'),
	dailyExpress: MEDIA('daily-express-1970-08-18-jt-jr.pdf'),
	scottishExpress1972: MEDIA('scottish-daily-express-1972-03-29.pdf'),
	aberdeenTranscript: MEDIA('aberdeen-transcript-1970-07-25.pdf'),
	concordance45: MEDIA('01M2NCMM7MB2FKC6HY7R901YGP.jpg'),
	concordance67: MEDIA('aberdeen-concordance-pages-06-07.jpeg'),
	concordance89: MEDIA('aberdeen-concordance-pages-08-09.jpeg'),
	hallAudio: MEDIA('01M2DNJ293BCY92Z2MBE8Z8B32.mp3'),
};

/** Image hrefs that should become the pamphlet PDF in Source Notes. */
const IMAGE_TO_WALK_LIGHT_PDF = new Set([
	MEDIA('01M2NCMCZ6BDNXMJJXNMQB47T2.jpg'),
	MEDIA('01M2NCMDNG33ABYHK1EX29VBFJ.jpg'),
	MEDIA('01M2NCMED1RA5QKYFJ6G8PJ3TE.jpg'),
]);

function newKey(prefix) {
	return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

function blockText(block) {
	return (Array.isArray(block?.children) ? block.children : [])
		.map((c) => (typeof c?.text === 'string' ? c.text : ''))
		.join('');
}

function scrubEditorial(text) {
	let t = String(text || '');
	const patterns = [
		/\s*Do not merge with Airylea\.?/gi,
		/\s*allegation, not an adjudicated finding\.?\s*/gi,
		/\s*_Time_\s*1966 is cited in working notes but the clipping is not in this repo, so it is not quoted here\.?/gi,
		/\s*Time\s*1966 is cited in working notes but the clipping is not in this repo, so it is not quoted here\.?/gi,
		/\s*Note:\s*James Alec Gardiner of Nigg\s*[≠!=]+\s*A\.?\s*J\.?\s*Gardiner of London\.?/gi,
		/\s*Framing per N15\/N16:\s*Saturday morning as precursor\.?/gi,
		/\s*\(standalone fact\)/gi,
		/\s*\(bridge\)/gi,
		/\s*[“"]William[”"] not identified as William Hales\.?/gi,
		/\s*Heart of piece\s*=\s*July[–-]August\.?/gi,
		/\s*Full technique reuse:\s*companion piece\.?/gi,
		/\s*concordance JPEG heads\s*\(notes 1\);\s*/gi,
		/\s*Friday\/Saturday spine per N15:\s*/gi,
		/\s*Criminalisation sequence as method:\s*synthesis of notes 30[–-]34\.?/gi,
		/\s*PDF:\s*/gi,
		/\s*page-checked\s+/gi,
		/\s*JPEG:\s*/gi,
		/;\s*pamphlet quotes?\s+P[\d–-]+/gi,
		/\s*P1\.\s*$/g,
		/\(\s*\)/g,
		/\s{2,}/g,
	];
	for (const re of patterns) t = t.replace(re, ' ');
	return t.replace(/\s{2,}/g, ' ').replace(/\s+([.;,:])/g, '$1').trim();
}

function needsRewrite(block) {
	if (!block || block._type !== 'block') return false;
	if (block.listItem !== 'number') return false;
	const t = blockText(block);
	const defs = Array.isArray(block.markDefs) ? block.markDefs : [];
	const hrefs = defs.filter((d) => d?._type === 'link').map((d) => String(d.href || ''));

	if (/Do not merge with Airylea|working notes but the clipping|Framing per N15|standalone fact|\(bridge\)|not identified as William Hales|Heart of piece|companion piece|concordance JPEG heads|PDF:/i.test(t)) {
		return true;
	}
	if (hrefs.some((h) => IMAGE_TO_WALK_LIGHT_PDF.has(h))) return true;
	if (/Destroy-order cover note|Stott intro, printed|Brighton inquisition|Finn Daily Express|Arrival, Airylea|Hindle Letter quotes|Sources for the whole|Brighton 28 Jul; pamphlet|Thursday evening before Kers|view destroy-order|view pamphlet page/i.test(t)) {
		return true;
	}
	if (/Bruce-era concordance/i.test(t)) {
		const missingDistinct =
			!hrefs.some((h) => h.includes('aberdeen-concordance-pages-06-07')) ||
			!hrefs.some((h) => h.includes('aberdeen-concordance-pages-08-09'));
		const wrongShared = hrefs.filter((h) => h.includes('01M2NCMM7MB2FKC6HY7R901YGP')).length >= 2;
		if (wrongShared || missingDistinct) return true;
	}
	// Scrub remaining editorial notes (N15 spine, synthesis method, etc.)
	if (/spine per N15|Criminalisation sequence as method|Full technique reuse|allegation, not an adjudicated/i.test(t)) {
		return true;
	}
	return false;
}

function spansWithLink(label, href, markDefs) {
	const key = newKey('cite');
	markDefs.push({ _type: 'link', _key: key, href });
	return [
		{ _type: 'span', _key: newKey('k'), text: label, marks: [key] },
	];
}

function plain(text) {
	return [{ _type: 'span', _key: newKey('k'), text }];
}

function em(text) {
	return [{ _type: 'span', _key: newKey('k'), text, marks: ['em'] }];
}

function rewriteNote(block) {
	const text = blockText(block);
	const markDefs = [];
	/** @type {object[]|null} */
	let children = null;
	let kind = 'scrub-editorial';

	if (/Bruce-era concordance/i.test(text)) {
		kind = 'note-concordance';
		children = [
			...plain(
				'Bruce-era concordance (Bible and Gospel Trust subject index, vols. 1–130, ministry of B. D. Hales). “a lie against a holy man of God”; “caught up in the stupidity” (',
			),
			...spansWithLink('concordance pp. 4–5', PDF.concordance45, markDefs),
			...plain('). “completely unsubstantial, unwitnessed, unsubstantiated, false”: '),
			...spansWithLink('concordance pp. 6–7', PDF.concordance67, markDefs),
			...plain('. Heading '),
			...em('ABERDEEN—test of'),
			...plain(': '),
			...spansWithLink('concordance pp. 8–9', PDF.concordance89, markDefs),
			...plain('.'),
		];
	} else if (/Hall highlights video|Listen to the full meeting/i.test(text)) {
		kind = 'note-hall-audio';
		children = [
			...plain('Hall highlights video with English captions. Full Saturday afternoon meeting (~76 minutes): '),
			...spansWithLink('Listen to the full meeting', PDF.hallAudio, markDefs),
			...plain('.'),
		];
	} else if (/Destroy-order cover note|If We Walk in the Light/i.test(text) && /destroy-order|cover note/i.test(text)) {
		kind = 'note-walk-light-destroy';
		children = [
			...plain('Destroy-order cover note: '),
			...em('If We Walk in the Light'),
			...plain(' (1970) — '),
			...spansWithLink('read the pamphlet PDF', PDF.walkLight, markDefs),
			...plain('.'),
		];
	} else if (/Stott intro, printed/i.test(text)) {
		kind = 'note-walk-light-58';
		children = [
			...plain(
				'Stott intro, printed p. 58: 100% support; Maynard upper garment; Storr against enquiry — ',
			),
			...spansWithLink('If We Walk in the Light (PDF)', PDF.walkLight, markDefs),
			...plain('.'),
		];
	} else if (/Brighton inquisition/i.test(text)) {
		kind = 'note-walk-light-60';
		children = [
			...plain(
				'Brighton inquisition, printed p. 60: “Are you 100% with J.T.Jr.”?; “J.T.Jr. is the issue.” — ',
			),
			...spansWithLink('If We Walk in the Light (PDF)', PDF.walkLight, markDefs),
			...plain('.'),
		];
	} else if (/Finn Daily Express 18 Aug/i.test(text)) {
		kind = 'note-daily-express';
		children = [
			...plain(
				'Finn Daily Express 18 Aug (whisky, arm, pure person, nothing happened): Adams Ch. XV — ',
			),
			...spansWithLink('Daily Express, 18 Aug 1970 (PDF)', PDF.dailyExpress, markDefs),
			...plain('.'),
		];
	} else if (/Thursday evening before Kers|I am a pure man/i.test(text) && /Steedman/i.test(text)) {
		kind = 'note-steedman-pdf';
		children = [
			...plain('Thursday evening before Kers; “I am a pure man…”: Steedman letter — '),
			...spansWithLink('Ted Steedman witness letter, 1970 (PDF)', PDF.steedman, markDefs),
			...plain('.'),
		];
	} else if (/Arrival, Airylea/i.test(text)) {
		kind = 'note-arrival';
		children = [
			...plain('Arrival, Airylea, Steedman loyalty / “everything to lose”: Adams Ch. XIV; '),
			...spansWithLink('Gardiner–McCallum statement (PDF)', PDF.gardinerMcCallum, markDefs),
			...plain('; '),
			...spansWithLink('Steedman letter (PDF)', PDF.steedman, markDefs),
			...plain('.'),
		];
	} else if (/Hindle Letter quotes/i.test(text)) {
		kind = 'note-hindle-quotes';
		children = [
			...plain('Hindle Letter quotes (criminals / Waterfall / dastardly lie / Brooklyn cheaper): Adams Ch. XIV — '),
			...spansWithLink('Hindle Letter (PDF)', PDF.hindle, markDefs),
			...plain('.'),
		];
	} else if (/Sources for the whole/i.test(text)) {
		kind = 'note-sources-whole';
		children = [
			...plain('Sources for the whole: '),
			...spansWithLink('Gardiner–McCallum (29 Jul 1970)', PDF.gardinerMcCallum, markDefs),
			...plain('; '),
			...spansWithLink('Steedman letter', PDF.steedman, markDefs),
			...plain('; '),
			...spansWithLink('Hindle Letter (12 Aug 1970)', PDF.hindle, markDefs),
			...plain('; Adams, '),
			...em('Goodbye, Beloved Brethren'),
			...plain(' (1972); Stott, '),
			...em('In the Days of Rain'),
			...plain(' (2017).'),
		];
	} else if (/Brighton 28 Jul; pamphlet/i.test(text)) {
		kind = 'note-brighton-pamphlet';
		children = [
			...plain('Brighton 28 Jul; pamphlet: Stott pp. 228–234; '),
			...em('If We Walk in the Light'),
			...plain(' intro — '),
			...spansWithLink('pamphlet PDF', PDF.walkLight, markDefs),
			...plain('.'),
		];
	} else if (/Scottish Daily Express, 29 March 1972|fake-tape/i.test(text) && false) {
		children = null;
	} else {
		// Generic scrub of editorial language; remap walk-light image links → PDF
		const nextKids = [];
		const oldDefs = Array.isArray(block.markDefs) ? block.markDefs : [];
		const keyMap = new Map();
		for (const d of oldDefs) {
			if (d?._type !== 'link') continue;
			let href = String(d.href || '');
			if (IMAGE_TO_WALK_LIGHT_PDF.has(href)) href = PDF.walkLight;
			const nk = newKey('cite');
			keyMap.set(d._key, nk);
			markDefs.push({ _type: 'link', _key: nk, href });
		}
		for (const span of block.children || []) {
			let raw = typeof span?.text === 'string' ? span.text : '';
			raw = scrubEditorial(raw);
			if (!raw) continue;
			const marks = (span.marks || [])
				.map((m) => (m === 'em' || m === 'code' ? m : keyMap.get(m) || m))
				.filter(Boolean);
			nextKids.push({
				_type: 'span',
				_key: newKey('k'),
				text: raw,
				...(marks.length ? { marks } : {}),
			});
		}
		// Join and re-scrub whole note text once more for cross-span phrases
		const joined = nextKids.map((c) => c.text).join('');
		const scrubbed = scrubEditorial(joined);
		if (scrubbed !== joined && nextKids.length === 1) {
			nextKids[0].text = scrubbed;
		} else if (scrubbed !== joined) {
			// rebuild as single scrubbed span preserving first link mark if any
			const linkMark = nextKids.find((c) => (c.marks || []).some((m) => markDefs.some((d) => d._key === m)));
			children = [
				{
					_type: 'span',
					_key: newKey('k'),
					text: scrubbed,
					...(linkMark?.marks ? { marks: linkMark.marks } : {}),
				},
			];
		} else {
			children = nextKids;
		}
		kind = 'scrub-editorial';
	}

	if (!children) {
		return { block, kind: 'noop' };
	}

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

export function transformCitationSourceNotesCleanupBlock(block, index) {
	if (!needsRewrite(block)) {
		return { block, change: null };
	}
	const beforeText = blockText(block);
	const beforeHrefs = (Array.isArray(block.markDefs) ? block.markDefs : [])
		.filter((d) => d?._type === 'link')
		.map((d) => String(d.href || ''))
		.join('|');
	const { block: after, kind } = rewriteNote(block);
	if (kind === 'noop') return { block, change: null };
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
			transform: 'citation-source-notes-cleanup',
			kind,
			before: { _type: 'block', text: beforeText.slice(0, 140), hrefs: beforeHrefs.slice(0, 180) },
			after: { _type: 'block', text: afterText.slice(0, 140), hrefs: afterHrefs.slice(0, 180) },
		},
	};
}

export const citationSourceNotesCleanupTransform = {
	id: 'citation-source-notes-cleanup',
	description:
		'Source Notes: remove editorial direction; link leaflets/letters to PDFs not extracted images',
	matches(block) {
		return needsRewrite(block);
	},
	transform: transformCitationSourceNotesCleanupBlock,
};
