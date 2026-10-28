/**
 * Alt text stored on an image field value (issue #108).
 *
 * In EmDash 1.3.1 the alt lives at the top level of the post's image value (`featured_image.alt`).
 * It is a snapshot: the admin picker copies the media library item's alt when the image is chosen,
 * and save-time normalisation fills an empty `alt` from the media item only when EmDash also has to
 * look up other metadata (`mergeProviderData` behind `needsLookup` in `media/normalize.ts`). Editing
 * alt in the media library does not update posts that already use the image; set it on the post's
 * image field or re-pick the image (#133).
 */
import { asMediaRecord, readTrimmedString } from './mediaValue';

/**
 * Top-level `alt`, then `meta.alt`, then the same on a nested `asset` (mirroring `readImageCaption`).
 * JSON-string values are parsed. Empty or whitespace-only alt reads as `null`.
 */
export function readImageAlt(value: unknown): string | null {
	const candidate = asMediaRecord(value);
	if (!candidate) {
		return null;
	}
	const meta = asMediaRecord(candidate.meta);
	const asset = asMediaRecord(candidate.asset);
	const assetMeta = asset ? asMediaRecord(asset.meta) : null;
	return (
		readTrimmedString(candidate.alt)
		?? readTrimmedString(meta?.alt)
		?? readTrimmedString(asset?.alt)
		?? readTrimmedString(assetMeta?.alt)
	);
}
