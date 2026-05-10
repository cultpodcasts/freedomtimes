/**
 * EmDash timestamp normalization.
 *
 * `getEmDashCollection` entries are `{ id, slug, status, data, cacheHint?, edit }`. Live timestamps
 * (`publishedAt`, `updatedAt`, `createdAt`) sit on **`data`**, typically as `Date` instances
 * (`typeof x === 'object'`, `x instanceof Date`). The thin wrapper has no top-level `publishedAt`.
 *
 * REST / other payloads may still expose snake_case or top-level aliases; we check **`data` first**,
 * then the entry/root object, with camelCase then snake_case per field group.
 */

/** Row with a `data` bag (`ContentEntry`, REST payload, etc.). */
export type EmDashTimestampSource = {
	data: unknown;
};

const PUBLISHED_KEYS = ['publishedAt', 'published_at'] as const;
const UPDATED_KEYS = ['updatedAt', 'updated_at'] as const;
const CREATED_KEYS = ['createdAt', 'created_at'] as const;

/** Single field: ISO string, finite epoch ms, `Date`, or object with `getTime()`. */
export function readDateCandidate(value: unknown): string | null {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		const d = new Date(value);
		return Number.isFinite(d.getTime()) ? d.toISOString() : null;
	}
	if (value instanceof Date && Number.isFinite(value.getTime())) {
		return value.toISOString();
	}
	if (value !== null && typeof value === 'object') {
		const withTime = value as { getTime?: () => number };
		if (typeof withTime.getTime === 'function') {
			const t = withTime.getTime();
			if (Number.isFinite(t)) return new Date(t).toISOString();
		}
	}
	return null;
}

function readFirstMatchingTimestamp(
	objects: readonly (Record<string, unknown> | null | undefined)[],
	keys: readonly string[],
): string | null {
	for (const obj of objects) {
		if (!obj || typeof obj !== 'object') continue;
		for (const key of keys) {
			const v = readDateCandidate(obj[key]);
			if (v) return v;
		}
	}
	return null;
}

function entryObjects(entry: EmDashTimestampSource): [Record<string, unknown>, Record<string, unknown>] {
	const data =
		entry.data !== null && typeof entry.data === 'object'
			? (entry.data as Record<string, unknown>)
			: {};
	return [data, entry as unknown as Record<string, unknown>];
}

/** Canonical publication time for an EmDash document / collection row. */
export function readEmDashPublishedAt(entry: EmDashTimestampSource): string | null {
	return readFirstMatchingTimestamp(entryObjects(entry), PUBLISHED_KEYS);
}

export function readEmDashUpdatedAt(entry: EmDashTimestampSource): string | null {
	return readFirstMatchingTimestamp(entryObjects(entry), UPDATED_KEYS);
}

export function readEmDashCreatedAt(entry: EmDashTimestampSource): string | null {
	return readFirstMatchingTimestamp(entryObjects(entry), CREATED_KEYS);
}

/** When the UI needs “some” origin time: published, else created (not updated). */
export function readEmDashPublishedOrCreatedAt(entry: EmDashTimestampSource): string | null {
	return readEmDashPublishedAt(entry) ?? readEmDashCreatedAt(entry);
}
