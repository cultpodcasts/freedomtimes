/**
 * Standfirsts are stored as plain text with markdown emphasis
 * (`_Politiken_`, `*Variety*`). Reader cards show that as italics.
 * A underscore inside a token (`some_word`) is left alone.
 */

export type ExcerptRun = {
	text: string;
	emphasis: boolean;
};

const EMPHASIS =
	/(?<![\p{L}\p{N}_])_([^_\n]+?)_(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}*])\*([^*\n]+?)\*(?![\p{L}\p{N}*])/gu;

export function excerptRuns(value: string): ExcerptRun[] {
	const text = value.trim();
	if (!text) return [];
	const runs: ExcerptRun[] = [];
	let last = 0;
	for (const match of text.matchAll(EMPHASIS)) {
		const start = match.index ?? 0;
		if (start > last) runs.push({ text: text.slice(last, start), emphasis: false });
		const inner = (match[1] ?? match[2] ?? '').trim();
		if (inner) runs.push({ text: inner, emphasis: true });
		last = start + match[0].length;
	}
	if (last < text.length) runs.push({ text: text.slice(last), emphasis: false });
	return runs;
}
