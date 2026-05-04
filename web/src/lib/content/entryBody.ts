/**
 * Resolves how an EmDash entry body is stored and should be rendered.
 * Portable Text (non-empty block array) vs legacy markdown string is the main split today;
 * per-collection adapters can wrap this later without growing `contentEntry.ts`.
 */

export type EntryBodyKind = 'portable-text' | 'markdown-legacy' | 'empty';

export type EntryBodyResolved = {
	kind: EntryBodyKind;
	portableContent: unknown[] | null;
	textContent: string | null;
};

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Read `data.content` from an EmDash `posts` (or similar) entry.
 * Empty arrays are treated as empty body (not PT) so we do not render broken Portable Text.
 */
export function resolveEntryBody(data: Record<string, unknown>): EntryBodyResolved {
	const raw = data.content;
	if (Array.isArray(raw) && raw.length > 0) {
		return { kind: 'portable-text', portableContent: raw, textContent: null };
	}
	const text = readString(raw);
	if (text) {
		return { kind: 'markdown-legacy', portableContent: null, textContent: text };
	}
	return { kind: 'empty', portableContent: null, textContent: null };
}
