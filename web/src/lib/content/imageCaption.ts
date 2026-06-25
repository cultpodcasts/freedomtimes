function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Caption on featured/cover images and inline portable-text image blocks. */
export function readImageCaption(value: unknown): string | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const candidate = value as Record<string, unknown>;
	const direct = readString(candidate.caption);
	if (direct) {
		return direct;
	}
	const meta =
		candidate.meta && typeof candidate.meta === 'object'
			? (candidate.meta as Record<string, unknown>)
			: null;
	const fromMeta = readString(meta?.caption);
	if (fromMeta) {
		return fromMeta;
	}

	const asset =
		candidate.asset && typeof candidate.asset === 'object'
			? (candidate.asset as Record<string, unknown>)
			: null;
	const fromAsset = readString(asset?.caption);
	if (fromAsset) {
		return fromAsset;
	}
	const assetMeta =
		asset?.meta && typeof asset.meta === 'object'
			? (asset.meta as Record<string, unknown>)
			: null;
	return readString(assetMeta?.caption);
}
