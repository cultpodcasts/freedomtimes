import { asMediaRecord, readTrimmedString } from './mediaValue';

/**
 * Caption on featured/cover images and inline portable-text image blocks. JSON-string values are
 * parsed (same shapes as `readImageAlt`).
 */
export function readImageCaption(value: unknown): string | null {
	const candidate = asMediaRecord(value);
	if (!candidate) {
		return null;
	}
	const meta = asMediaRecord(candidate.meta);
	const asset = asMediaRecord(candidate.asset);
	const assetMeta = asset ? asMediaRecord(asset.meta) : null;
	return (
		readTrimmedString(candidate.caption)
		?? readTrimmedString(meta?.caption)
		?? readTrimmedString(asset?.caption)
		?? readTrimmedString(assetMeta?.caption)
	);
}
