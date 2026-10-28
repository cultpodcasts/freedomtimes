/**
 * Hero (featured/cover) image alt text — issue #108.
 *
 * EmDash 1.3.1 stores an image field on the post as a media value (`ImageValue` / `MediaValue`):
 * `{ id, provider, alt?, caption?, meta?: { storageKey, … }, … }`. The editor copies the media
 * library item's `alt` onto that value when the image is chosen, and EmDash's save-time
 * normalisation fills an empty `alt` from the media item. So the image's own alt lives at
 * `data.featured_image.alt` (or `data.cover_image.alt`). Pure module (no `cloudflare:` imports)
 * so it can be unit-tested with tsx.
 */

export type HeroImageField = 'featured_image' | 'cover_image';

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed.startsWith('{')) {
			return null;
		}
		try {
			const parsed: unknown = JSON.parse(trimmed);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Alt text stored on an image field value (top-level `alt`, then `meta.alt`, then the same on a
 * nested `asset`, mirroring `readImageCaption`). Empty or whitespace-only alt reads as `null`.
 */
export function readImageAlt(value: unknown): string | null {
	const candidate = asRecord(value);
	if (!candidate) {
		return null;
	}
	const meta = asRecord(candidate.meta);
	const asset = asRecord(candidate.asset);
	const assetMeta = asset ? asRecord(asset.meta) : null;
	return (
		readString(candidate.alt)
		?? readString(meta?.alt)
		?? readString(asset?.alt)
		?? readString(assetMeta?.alt)
	);
}

/** Generic alt used only when no alt is stored for the hero image. */
export function genericHeroImageAlt(title: string): string {
	return `${title} featured image`;
}

/**
 * Alt for the hero `<img>`. `heroField` is the field whose image is actually rendered
 * (`featured_image` wins over `cover_image`, matching `featuredImageSrc`).
 *
 * Order: that image's own stored alt → legacy flat `featured_image_alt` / `cover_image_alt`
 * strings → `"<title> featured image"`.
 */
export function resolveHeroImageAlt(
	data: Record<string, unknown>,
	title: string,
	heroField: HeroImageField,
): string {
	return (
		readImageAlt(data[heroField])
		?? readString(data.featured_image_alt)
		?? readString(data.cover_image_alt)
		?? genericHeroImageAlt(title)
	);
}
