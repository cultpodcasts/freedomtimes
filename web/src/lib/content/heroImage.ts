/**
 * Hero (featured/cover) image for post and page views (issue #108).
 *
 * The rendered field is chosen once and both `src` and `alt` come from that same field:
 * `featured_image` when it has a file, else `cover_image` when it has one, else nothing.
 *
 * ```mermaid
 * flowchart TD
 *   A[featured_image has a file?] -- yes --> F[field = featured_image]
 *   A -- no --> B[cover_image has a file?]
 *   B -- yes --> C[field = cover_image]
 *   B -- no --> N[field = null, src = null]
 *   F --> ALT
 *   C --> ALT
 *   N --> ALT
 *   ALT["alt = field.alt → legacy &lt;field&gt;_alt → other legacy _alt → '&lt;title&gt; featured image'"]
 * ```
 */
import { readImageAlt } from './imageAlt';
import { readMediaValueSrc, readTrimmedString } from './mediaValue';

export type HeroImageField = 'featured_image' | 'cover_image';

export type HeroImage = {
	/** Field whose image is rendered, or `null` when neither has a file. */
	field: HeroImageField | null;
	src: string | null;
	alt: string;
};

/** Generic alt used only when no alt is stored for the hero image. */
export function genericHeroImageAlt(title: string): string {
	return `${title} featured image`;
}

const OTHER_FIELD: Record<HeroImageField, HeroImageField> = {
	featured_image: 'cover_image',
	cover_image: 'featured_image',
};

export function resolveHeroImage(data: Record<string, unknown>, title: string): HeroImage {
	const featuredSrc = readMediaValueSrc(data.featured_image);
	const coverSrc = featuredSrc ? null : readMediaValueSrc(data.cover_image);
	const field: HeroImageField | null = featuredSrc ? 'featured_image' : coverSrc ? 'cover_image' : null;
	const src = featuredSrc ?? coverSrc;

	// Legacy flat `<field>_alt` strings, rendered field first; featured first when nothing renders.
	const legacyOrder: HeroImageField[] = field ? [field, OTHER_FIELD[field]] : ['featured_image', 'cover_image'];
	const alt =
		(field ? readImageAlt(data[field]) : null)
		?? legacyOrder.map((f) => readTrimmedString(data[`${f}_alt`])).find((value) => value !== null)
		?? genericHeroImageAlt(title);

	return { field, src, alt };
}
