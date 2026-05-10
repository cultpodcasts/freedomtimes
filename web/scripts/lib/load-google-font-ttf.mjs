/**
 * Fetch a Google Fonts TTF for Satori/Resvg.
 *
 * Uses the same User-Agent as `generate-social-images.ts` so Playfair / Inter / Source Serif
 * binaries match across article OG cards, homepage OG, and favicon/avatar raster renders.
 */
export const GOOGLE_FONTS_TTF_USER_AGENT =
	'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1';

/**
 * @param {string} family e.g. `'Playfair Display'`
 * @param {number} weight e.g. 900
 * @returns {Promise<ArrayBuffer>}
 */
export async function loadGoogleFontTtf(family, weight) {
	const url = `https://fonts.googleapis.com/css2?family=${family.replace(/\s+/g, '+')}:wght@${weight}&display=swap`;
	const cssRes = await fetch(url, {
		headers: { 'User-Agent': GOOGLE_FONTS_TTF_USER_AGENT },
	});
	if (!cssRes.ok) {
		throw new Error(`font CSS ${cssRes.status}: ${family} ${weight}`);
	}
	const css = await cssRes.text();
	const resource = css.match(/src:\s*url\((https:\/\/[^)]+)\)\s*format\('(truetype|opentype)'\)/);
	if (!resource?.[1]) {
		throw new Error(`No TTF/OTF URL in Google Fonts CSS for ${family} ${weight}`);
	}
	const fontRes = await fetch(resource[1]);
	if (!fontRes.ok) {
		throw new Error(`font file ${fontRes.status}: ${family} ${weight}`);
	}
	return await fontRes.arrayBuffer();
}
