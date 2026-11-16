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
 *   ALT["sync resolveHeroImage alt = field.alt → legacy &lt;field&gt;_alt → other legacy _alt → '&lt;title&gt; featured image'"]
 *   ALT -. empty/generic only .-> ASYNC["async resolveHeroImageAltFromMediaWith: Turso media.alt, bounded (#133, #195)"]
 * ```
 *
 * The post stores a snapshot of alt when the image is picked. Sync {@link resolveHeroImage}
 * never reads the media library. When that snapshot is empty/generic,
 * {@link resolveHeroImageAltFromMediaWith} can fill from the media library row (#133). That
 * lookup must never reject: it runs from component frontmatter after the 200 headers (#123).
 *
 * #195: there is no HTTP fallback. It used to fetch `${origin}/_emdash/api/media/<id>` when Turso
 * had no alt. That is a Worker → own-hostname subrequest, which Cloudflare cannot route back to the
 * Worker: it failed with a 522 after ~20 s on every uncached render of a page whose hero has no alt.
 * The media API reads the same Turso row anyway. The Turso read is capped by
 * {@link timedRenderLookup} and logs when slow. Pass `lookupOptions.budget` to share the page's
 * render budget with the social-image lookups, so one hung Turso costs one timeout per render.
 */
import { readImageAlt } from './imageAlt';
import { readImageFieldMediaId, readMediaValueSrc, readTrimmedString } from './mediaValue';
import { isRenderLookupBoundError, timedRenderLookup, type RenderLookupOptions } from './renderLookup';

/** Slice of a libsql client used for the hero media.alt lookup (`@libsql/client/web` satisfies it). */
export type HeroImageQueryClient = {
	execute(statement: { sql: string; args: string[] }): Promise<{ rows: unknown[] }>;
};

/** Builds the client, or returns `null` when Turso is not configured. May throw (bad URL / scheme). */
export type HeroImageClientFactory = () => HeroImageQueryClient | null;

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

/**
 * The hero alt to use for `og:image:alt` when the social image fell back to the hero (#132).
 * The generic `"<title> featured image"` is not a description of the photo, so it returns null.
 */
export function storedHeroImageAlt(alt: string, title: string): string | null {
	const stored = alt.trim();
	if (!stored || stored === genericHeroImageAlt(title)) return null;
	return stored;
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

const LOG_PREFIX = '[contentEntry] resolveHeroImageAltFromMedia';

/**
 * When the hero has no stored alt (only the generic `"<title> featured image"`), look up `media.alt`
 * by the rendered field's media id (#133). Never rejects: failures, a missing client, an empty
 * library alt, a timeout or a tripped budget keep `currentAlt`. Never makes an HTTP request (#195).
 */
export async function resolveHeroImageAltFromMediaWith(
	createClient: HeroImageClientFactory,
	data: Record<string, unknown>,
	title: string,
	currentAlt: string,
	lookupOptions?: RenderLookupOptions,
): Promise<string> {
	try {
		if (storedHeroImageAlt(currentAlt, title)) return currentAlt;

		const { field } = resolveHeroImage(data, title);
		if (!field) return currentAlt;
		const mediaId = readImageFieldMediaId(data[field]);
		if (!mediaId) return currentAlt;

		// An earlier lookup in this render already timed out: do not even build a client (#195).
		if (lookupOptions?.budget?.trippedBy) return currentAlt;

		let client: HeroImageQueryClient | null = null;
		try {
			client = createClient();
		} catch (err) {
			console.error(`${LOG_PREFIX}: libsql client creation failed; keeping snapshot/generic alt`, err);
		}

		if (client) {
			try {
				const queryClient = client;
				const res = await timedRenderLookup(
					'hero_alt.media',
					() =>
						queryClient.execute({
							sql: 'select alt from media where id = ? limit 1',
							args: [mediaId],
						}),
					lookupOptions,
				);
				const row = res.rows[0] as Record<string, unknown> | undefined;
				const alt = row && typeof row.alt === 'string' ? row.alt.trim() : '';
				if (alt.length > 0) return alt;
			} catch (err) {
				// Timeouts / skips are already logged as ft.render.* by timedRenderLookup.
				if (!isRenderLookupBoundError(err)) console.error(`${LOG_PREFIX}: Turso media alt lookup failed`, err);
			}
		}
	} catch (err) {
		console.error(`${LOG_PREFIX}: unexpected failure; keeping snapshot/generic alt`, err);
	}
	return currentAlt;
}
