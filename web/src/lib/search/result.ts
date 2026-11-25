/**
 * What a search hit shows: the story image, a short standfirst around the
 * match, and a few subjects. The article body is not read.
 */
import { normalizeLocalMediaValue } from '../content/homepage-entries-map';
import { readImageAlt } from '../content/imageAlt';
import { asMediaRecord, readMediaValueSrc, readTrimmedString } from '../content/mediaValue';
import { excerptRuns, type ExcerptRun } from './excerpt';

export type SnippetRun = ExcerptRun & { mark: boolean };

const SNIPPET_CHARS = 220;
const SUBJECTS_SHOWN = 4;

export function readSearchImage(value: unknown): { src: string | null; alt: string | null } {
	let parsed: unknown = value;
	if (typeof value === 'string') {
		const record = asMediaRecord(value);
		parsed = record ?? value;
	}
	const normalized = normalizeLocalMediaValue(parsed);
	const src = readMediaValueSrc(normalized) ?? imageSrcFromId(normalized);
	return { src, alt: readImageAlt(normalized) };
}

function imageSrcFromId(value: unknown): string | null {
	const record = asMediaRecord(value) ?? (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
	const id = record ? readTrimmedString(record.id) : null;
	return id ? `/_emdash/api/media/file/${id}` : null;
}

export function queryTokens(query: string): string[] {
	const seen = new Set<string>();
	const tokens: string[] = [];
	for (const raw of query.split(/\s+/)) {
		const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
		if (token.length < 2) continue;
		const key = token.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		tokens.push(token);
	}
	return tokens.sort((a, b) => b.length - a.length);
}

/** Standfirst window around the first query match, with italics and marks. */
export function searchSnippet(value: string, query: string, maxChars = SNIPPET_CHARS): SnippetRun[] {
	const runs = excerptRuns(value);
	if (runs.length === 0) return [];
	const plain = runs.map((run) => run.text).join('');
	const tokens = queryTokens(query);
	const lower = plain.toLocaleLowerCase();
	let matchAt = -1;
	for (const token of tokens) {
		const at = lower.indexOf(token.toLocaleLowerCase());
		if (at >= 0 && (matchAt < 0 || at < matchAt)) matchAt = at;
	}

	let start = 0;
	let end = plain.length;
	if (plain.length > maxChars) {
		if (matchAt < 0) {
			end = maxChars;
		} else {
			const half = Math.floor(maxChars / 2);
			start = Math.max(0, matchAt - half);
			end = Math.min(plain.length, start + maxChars);
			start = Math.max(0, end - maxChars);
		}
		if (start > 0) {
			const space = plain.indexOf(' ', start);
			if (space > start && space < start + 32 && (matchAt < 0 || space < matchAt)) start = space + 1;
		}
		if (end < plain.length) {
			const space = plain.lastIndexOf(' ', end);
			if (space > start + 40) end = space;
		}
	}

	const sliced = sliceRuns(runs, start, end);
	const marked = markRuns(sliced, tokens);
	if (marked.length === 0) return [];
	if (start > 0) marked[0] = { ...marked[0], text: `…${marked[0].text}` };
	if (end < plain.length) {
		const last = marked.length - 1;
		marked[last] = { ...marked[last], text: `${marked[last].text}…` };
	}
	return marked;
}

/** Mark query words in a title. No windowing. */
export function markQuery(value: string, query: string): SnippetRun[] {
	const runs = excerptRuns(value);
	if (runs.length === 0) return [];
	return markRuns(runs, queryTokens(query));
}

/** Subjects that contain the query come first. The rest of a long chip row stays off the card. */
export function subjectsForSearch(subjects: readonly string[], query: string, limit = SUBJECTS_SHOWN): { shown: string[]; more: number } {
	const tokens = queryTokens(query).map((token) => token.toLocaleLowerCase());
	const ranked = subjects.map((label, index) => ({
		label,
		index,
		hit: tokens.some((token) => label.toLocaleLowerCase().includes(token)),
	}));
	ranked.sort((a, b) => Number(b.hit) - Number(a.hit) || a.index - b.index);
	const shown = ranked.slice(0, limit).map((item) => item.label);
	return { shown, more: Math.max(0, subjects.length - shown.length) };
}

function sliceRuns(runs: readonly ExcerptRun[], start: number, end: number): ExcerptRun[] {
	const out: ExcerptRun[] = [];
	let cursor = 0;
	for (const run of runs) {
		const runStart = cursor;
		const runEnd = cursor + run.text.length;
		cursor = runEnd;
		if (runEnd <= start || runStart >= end) continue;
		const text = run.text.slice(Math.max(0, start - runStart), Math.min(run.text.length, end - runStart));
		if (text) out.push({ text, emphasis: run.emphasis });
	}
	return out;
}

function markRuns(runs: readonly ExcerptRun[], tokens: readonly string[]): SnippetRun[] {
	if (tokens.length === 0) return runs.map((run) => ({ ...run, mark: false }));
	const pattern = new RegExp(tokens.map(escapeRegExp).join('|'), 'giu');
	const out: SnippetRun[] = [];
	for (const run of runs) {
		let last = 0;
		for (const match of run.text.matchAll(pattern)) {
			const at = match.index ?? 0;
			if (at > last) out.push({ text: run.text.slice(last, at), emphasis: run.emphasis, mark: false });
			if (match[0]) out.push({ text: match[0], emphasis: run.emphasis, mark: true });
			last = at + match[0].length;
		}
		if (last < run.text.length) out.push({ text: run.text.slice(last), emphasis: run.emphasis, mark: false });
	}
	return out.filter((run) => run.text.length > 0);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
