import { execSync } from 'node:child_process';
import fs from 'fs/promises';
import path from 'path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

/** Open Graph / social share image size (Facebook, X, LinkedIn, etc.). */
const OG_WIDTH = 1200;
const OG_HEIGHT = 675;
const MAX_SOCIAL_IMAGE_BYTES = 600 * 1024;

/** Side margins (60px each); keeps headline inside the canvas before root overflow clips. */
const TITLE_BLOCK_MAX_PX = OG_WIDTH - 120;

/** Translucent white behind type (lower alpha = more see-through). */
const TITLE_PANEL_BG = 'rgba(255, 255, 255, 0.52)';

/** Max headline rows above the site / date line. */
const TITLE_MAX_LINES = 4;

/** Common named HTML entities (decode after numeric entities; &amp; handled in map). */
const HTML_NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00A0',
	ndash: '\u2013',
	mdash: '\u2014',
	hellip: '\u2026',
	lsquo: '\u2018',
	rsquo: '\u2019',
	ldquo: '\u201C',
	rdquo: '\u201D',
	bull: '\u2022',
	deg: '\u00B0',
	euro: '\u20AC',
	pound: '\u00A3',
	copy: '\u00A9',
	reg: '\u00AE',
};

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readDateCandidate(value: unknown): string | null {
	const v = readString(value);
	if (!v) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeMediaFileUrl(value: unknown): string | null {
	if (!value) return null;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) return null;
		if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
			return trimmed;
		}
		return `/_emdash/api/media/file/${trimmed}`;
	}
	if (typeof value === 'object') {
		const rec = value as Record<string, unknown>;
		const src = readString(rec.src) ?? readString(rec.url);
		if (src) return src;
		const key = readString(rec.storageKey)
			?? readString(rec.storage_key)
			?? readString((rec.meta as Record<string, unknown> | undefined)?.storageKey)
			?? readString((rec.meta as Record<string, unknown> | undefined)?.storage_key);
		if (key) return `/_emdash/api/media/file/${key}`;
		const id = readString(rec.id);
		if (id) return `/_emdash/api/media/file/${id}`;
	}
	return null;
}

function decodeHtmlEntitiesOnce(value: string): string {
	let s = value
		.replace(/&#x([0-9a-f]{1,6});/gi, (full, hex) => {
			const cp = Number.parseInt(hex, 16);
			if (!Number.isFinite(cp) || cp < 0 || cp > 0x10_ffff) return full;
			try {
				return String.fromCodePoint(cp);
			} catch {
				return full;
			}
		})
		.replace(/&#(\d{1,7});/g, (full, dec) => {
			const cp = Number.parseInt(dec, 10);
			if (!Number.isFinite(cp) || cp < 0 || cp > 0x10_ffff) return full;
			try {
				return String.fromCodePoint(cp);
			} catch {
				return full;
			}
		});
	s = s.replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => HTML_NAMED_ENTITIES[name.toLowerCase()] ?? m);
	return s;
}

/** Unescape HTML entities; repeat passes so `&amp;#39;` etc. collapse correctly. */
function decodeHtmlEntities(value: string): string {
	let s = value;
	for (let i = 0; i < 6; i++) {
		const next = decodeHtmlEntitiesOnce(s);
		if (next === s) break;
		s = next;
	}
	return s;
}

function normalizeText(value: string): string {
	return decodeHtmlEntities(value)
		// Ornamental / uncommon quotes (often missing from display fonts → tofu); use ASCII.
		.replace(/[\u275D\u275E\u301D\u301E\u201C\u201D\u201E\u201F\u00AB\u00BB\uFF02]/g, '"')
		.replace(/[\u275B\u275C\u301F\u2018\u2019\u201A\u201B\uFF07]/g, "'")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/\u2013/g, '-')
		.replace(/\u2014/g, '--');
}

function formatDate(value: string | null): string {
	if (!value) return '';
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return '';
	return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Last line when more words remain: word-boundary ellipsis, avoid a clipped trailing word. */
function appendEllipsisToLine(segment: string, maxCharsPerLine: number): string {
	const trimmed = segment.replace(/[.,;:!?-]+$/u, '');
	const suf = '...';
	const parts = trimmed.split(/\s+/).filter(Boolean);
	if (parts.length >= 2) {
		parts.pop();
	}
	while (parts.length > 0) {
		const core = parts.join(' ');
		const totalLen = core.length + (core.length > 0 ? 1 : 0) + suf.length;
		if (totalLen <= maxCharsPerLine) break;
		parts.pop();
	}
	const lineText = parts.join(' ');
	return lineText.length > 0 ? `${lineText} ${suf}` : suf;
}

function wrapTitle(
	title: string,
	maxCharsPerLine = 28,
	maxLines = TITLE_MAX_LINES,
): string[] {
	const words = title.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return ['Untitled'];

	const lines: string[] = [];
	let wordIndex = 0;

	function fillLine(hardBreakOversizedWord: boolean): string {
		let line = '';
		while (wordIndex < words.length) {
			const w = words[wordIndex];
			const next = line.length > 0 ? `${line} ${w}` : w;
			if (next.length <= maxCharsPerLine) {
				line = next;
				wordIndex++;
			} else if (line.length === 0) {
				if (w.length > maxCharsPerLine && hardBreakOversizedWord) {
					line = `${w.slice(0, Math.max(1, maxCharsPerLine - 1))}…`;
				} else {
					line = w;
				}
				wordIndex++;
				break;
			} else {
				break;
			}
		}
		return line;
	}

	for (let lineIndex = 0; lineIndex < maxLines; lineIndex++) {
		if (wordIndex >= words.length) break;

		const isLastLine = lineIndex === maxLines - 1;
		const segment = fillLine(lineIndex === 0);

		if (segment.length === 0) break;

		if (isLastLine && wordIndex < words.length) {
			lines.push(appendEllipsisToLine(segment, maxCharsPerLine));
		} else {
			lines.push(segment);
		}
	}

	return lines.length > 0 ? lines : ['Untitled'];
}

async function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer | null> {
	try {
		const url = `https://fonts.googleapis.com/css2?family=${family.replace(/\s+/g, '+')}:wght@${weight}&display=swap`;
		const cssRes = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1',
			},
		});
		if (!cssRes.ok) return null;
		const css = await cssRes.text();
		const resource = css.match(/src:\s*url\((https:\/\/[^)]+)\)\s*format\('(truetype|opentype)'\)/);
		if (!resource) return null;
		const fontRes = await fetch(resource[1]);
		if (!fontRes.ok) return null;
		return await fontRes.arrayBuffer();
	} catch {
		return null;
	}
}

async function uploadMedia(filePath: string, altText: string, apiUrl: string, token: string) {
	const formData = new FormData();
	const fileBuffer = await fs.readFile(filePath);
	const blob = new Blob([fileBuffer], { type: 'image/png' });
	formData.append('file', blob, path.basename(filePath));
	formData.append('alt', altText);
	formData.append('name', path.basename(filePath));

	const uploadRes = await fetch(`${apiUrl}/_emdash/api/media`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`
		},
		body: formData as any
	});

	if (!uploadRes.ok) {
		const txt = await uploadRes.text();
		throw new Error(`Failed to upload media: ${uploadRes.status} ${txt}`);
	}
	return await uploadRes.json();
}

async function optimizePngUnderLimit(
	input: Buffer,
	maxBytes = MAX_SOCIAL_IMAGE_BYTES,
): Promise<Buffer> {
	if (input.byteLength <= maxBytes) return input;

	const attempts = [
		{ quality: 92, colors: 256, dither: 1.0 },
		{ quality: 88, colors: 192, dither: 0.95 },
		{ quality: 82, colors: 128, dither: 0.9 },
		{ quality: 76, colors: 96, dither: 0.85 },
		{ quality: 70, colors: 64, dither: 0.8 },
		{ quality: 62, colors: 48, dither: 0.75 },
	] as const;

	let best = input;
	for (const attempt of attempts) {
		const candidate = await sharp(input)
			.png({
				compressionLevel: 9,
				palette: true,
				quality: attempt.quality,
				colors: attempt.colors,
				dither: attempt.dither,
				effort: 10,
				progressive: false,
			})
			.toBuffer();
		if (candidate.byteLength < best.byteLength) {
			best = candidate;
		}
		if (candidate.byteLength <= maxBytes) {
			return candidate;
		}
	}

	return best;
}

async function main() {
	const args = process.argv.slice(2);
	const slug = args[0];

	const apiUrl = process.env.EMDASH_URL || process.env.EMDASH_STAGING_URL || 'https://staging.freedomtimes.news';
	let token = process.env.EMDASH_TOKEN || process.env.EMDASH_STAGING_TOKEN || '';

	if (!token) {
		try {
			const authPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'emdash', 'auth.json');
			const authData = JSON.parse(await fs.readFile(authPath, 'utf8'));
			if (authData[apiUrl] && authData[apiUrl].accessToken) {
				token = authData[apiUrl].accessToken;
			}
		} catch (e) {
			console.log("Could not read auth.json, proceeding with empty token.");
		}
	}

	if (!slug) {
		console.error("Usage: tsx scripts/generate-social-images.ts <slug>");
		process.exit(1);
	}

	console.log(`Fetching post ${slug} from ${apiUrl}...`);
	const getRes = await fetch(`${apiUrl}/_emdash/api/content/posts/${slug}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.emdash.portable-text+json, application/json'
		}
	});

	if (!getRes.ok) {
		console.error(`Failed to fetch post: ${getRes.status}`);
		process.exit(1);
	}

	const rawItem = await getRes.json();
	console.log("Raw item keys:", Object.keys(rawItem));
	console.log("Raw item data keys:", rawItem.data ? Object.keys(rawItem.data) : "undefined");
	
	const postItem = rawItem.data?.item || rawItem;
	const data = (postItem?.data ?? {}) as Record<string, unknown>;
	const title = readString(data.title)
		?? readString(data.name)
		?? readString(data.headline)
		?? readString(postItem?.slug)
		?? 'Untitled';
	const featuredImageSrc =
		normalizeMediaFileUrl(data.featured_image)
		?? normalizeMediaFileUrl(data.cover_image);
	const publishedAt =
		readDateCandidate((postItem as Record<string, unknown>)?.publishedAt)
		?? readDateCandidate((postItem as Record<string, unknown>)?.published_at)
		?? readDateCandidate(data.publishedAt)
		?? readDateCandidate(data.published_at)
		?? readDateCandidate((postItem as Record<string, unknown>)?.updatedAt)
		?? readDateCandidate((postItem as Record<string, unknown>)?.updated_at)
		?? readDateCandidate(data.updatedAt)
		?? readDateCandidate(data.updated_at);

	console.log("Extracted title:", title);
	console.log("postItem.data.title:", postItem.data?.title);
	if (!postItem.data?.title) {
		console.warn("WARNING: Title is missing from data!");
	}

	let bgUrl = featuredImageSrc ? new URL(featuredImageSrc, apiUrl).toString() : '';
	// Use absolute internal URL for fetching if relative
	if (featuredImageSrc?.startsWith('/')) {
		bgUrl = `${apiUrl}${featuredImageSrc}`;
	}

	const normalizedTitle = normalizeText(title);
	const titleLines = wrapTitle(normalizedTitle);
	const dateText = formatDate(publishedAt);
	
	const titleLineStyle = {
		marginBottom: '8px',
		display: 'flex' as const,
		maxWidth: `${TITLE_BLOCK_MAX_PX}px`,
		backgroundColor: TITLE_PANEL_BG,
		padding: '16px 24px',
		color: '#000000',
		lineHeight: 1.08,
		fontFamily: '"Playfair Display", "Noto Sans"',
	};

	const titleNodes = titleLines.map((line) => ({
		type: 'div',
		props: {
			style: titleLineStyle,
			children: line,
		},
	}));

	let bgImageNode = null;
	if (bgUrl) {
		// Read the image directly to an ArrayBuffer or base64 to pass to Satori
		try {
			console.log(`Fetching bg image ${bgUrl}...`);
			const res = await fetch(bgUrl, {
				headers: { Authorization: `Bearer ${token}` }
			});
			if (res.ok) {
				const buffer = await res.arrayBuffer();
				const base64 = Buffer.from(buffer).toString('base64');
				const mimeType = res.headers.get('content-type') || 'image/jpeg';
				console.log(`Fetched bg image, buffer size: ${buffer.byteLength}, type: ${mimeType}`);
				bgImageNode = {
					type: 'div',
					props: {
						style: {
							position: 'absolute',
							left: 0,
							top: 0,
							width: `${OG_WIDTH}px`,
							height: `${OG_HEIGHT}px`,
							backgroundImage: `url('data:${mimeType};base64,${base64}')`,
							backgroundSize: 'cover',
							backgroundPosition: 'center',
						},
					},
				};
			} else {
				console.error(`Failed to fetch bg image: ${res.status}`);
			}
		} catch (e) {
			console.error("Failed to load bg image", e);
		}
	}

	const [fontPlayfair, fontNoto900] = await Promise.all([
		loadGoogleFont('Playfair Display', 900),
		loadGoogleFont('Noto Sans', 900),
	]);
	if (!fontPlayfair || !fontNoto900) {
		throw new Error('Could not load fonts (Playfair Display and Noto Sans required)');
	}

	console.log("Generating layout with Satori...");
	const vdom = {
		type: 'div',
		props: {
			style: {
				display: 'flex',
				position: 'relative',
				width: `${OG_WIDTH}px`,
				height: `${OG_HEIGHT}px`,
				background: '#ffffff',
				overflow: 'hidden',
			},
			children: [
				bgImageNode,
				{
					type: 'div',
					props: {
						style: {
							position: 'absolute',
							left: '60px',
							right: '60px',
							bottom: '60px',
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'flex-start',
							justifyContent: 'flex-end',
						},
						children: [
							{
								type: 'div',
								props: {
									style: {
										display: 'flex',
										flexDirection: 'column',
										alignItems: 'flex-start',
										maxWidth: `${TITLE_BLOCK_MAX_PX}px`,
										fontSize: '72px',
										fontWeight: 900,
										letterSpacing: '-0.01em',
									},
									children: titleNodes,
								},
							},
							{
								type: 'div',
								props: {
									style: {
										display: 'flex',
										fontSize: '32px',
										fontWeight: 900,
										color: '#000000',
										fontFamily: '"Playfair Display", "Noto Sans"',
										letterSpacing: '-0.01em',
										marginTop: '16px',
										maxWidth: `${TITLE_BLOCK_MAX_PX}px`,
										backgroundColor: TITLE_PANEL_BG,
										padding: '12px 24px',
									},
									children: `freedomtimes.news${dateText ? `  •  ${dateText}` : ''}`,
								},
							},
						]
					}
				}
			].filter(Boolean)
		}
	};

	const svg = await satori(vdom as any, {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		fonts: [
			{ name: 'Playfair Display', data: fontPlayfair, weight: 900, style: 'normal' },
			{ name: 'Noto Sans', data: fontNoto900, weight: 900, style: 'normal' },
		],
	});

	console.log("Rendering PNG with Resvg...");
	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: OG_WIDTH },
	});
	const pngDataRaw = resvg.render().asPng();
	const pngData = await optimizePngUnderLimit(pngDataRaw);
	const outPath = path.join(process.cwd(), '.release', `${slug}-social.png`);
	await fs.mkdir(path.dirname(outPath), { recursive: true });
	await fs.writeFile(outPath, pngData);
	const pngBytes = pngData.byteLength;
	if (pngBytes > MAX_SOCIAL_IMAGE_BYTES) {
		throw new Error(
			`Social image is ${pngBytes} bytes after optimization; must be <= ${MAX_SOCIAL_IMAGE_BYTES}.`,
		);
	}
	console.log(`Saved PNG to ${outPath} (${pngBytes} bytes)`);

	console.log(`Uploading to EmDash...`);
	const uploadResult = await uploadMedia(outPath, `${normalizedTitle} share preview`, apiUrl, token);
	console.log("Upload result:", uploadResult);

	console.log("featured_image is:", JSON.stringify(postItem.data.featured_image, null, 2));

	console.log(`Updating post ${slug} using EmDash CLI...`);
	const uploaded = uploadResult.data.item as Record<string, unknown>;
	const storageKey = typeof uploaded.storageKey === 'string' ? uploaded.storageKey : '';
	postItem.data.social_image = {
		id: uploaded.id,
		provider: 'local',
		filename: uploaded.filename,
		mimeType: uploaded.mimeType,
		meta: storageKey ? { storageKey } : {},
	};

	const tmpDataFile = path.join(process.cwd(), '.release', `${slug}-data.json`);
	await fs.writeFile(tmpDataFile, JSON.stringify(postItem.data, null, 2));

	try {
		const updateOut = execSync(`npx emdash content update posts ${slug} --rev ${rawItem.data?._rev || rawItem._rev} --file ${tmpDataFile} --url ${apiUrl} --json`, {
			env: { ...process.env, EMDASH_TOKEN: token, EMDASH_HEADERS: `Authorization: Bearer ${token}` },
			encoding: 'utf8'
		});
		console.log("CLI Update output:", updateOut);
	} catch (err: unknown) {
		const detail =
			err && typeof err === 'object' && 'stdout' in err
				? String((err as { stdout?: Buffer }).stdout ?? '')
				: err instanceof Error
					? err.message
					: String(err);
		console.error('CLI Update failed:', detail || err);
		process.exit(1);
	}

	console.log("Success!");
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
