/**
 * Adapter: a Cloudflare D1 binding as the libsql `execute({ sql, args }) → { rows }` slice used by
 * the direct content lookups (socialImage.ts, heroImage.ts). PR #198: with FT_CONTENT_BACKEND=d1
 * those lookups must read the same D1 `EMDASH` database EmDash serves, never Turso.
 *
 * Pure (the binding is passed in) so scripts/test-d1-query-client.mts can drive it with a fake.
 * D1 `.all()` rows are objects keyed by column name, which is how the callers read libsql rows.
 */

/** The slice of a D1 binding this adapter uses (`D1Database` satisfies it). */
export type D1Like = {
	prepare(sql: string): {
		bind(...values: unknown[]): { all(): Promise<{ results?: unknown[] }> };
	};
};

export type ContentQueryClient = {
	execute(statement: { sql: string; args: string[] }): Promise<{ rows: unknown[] }>;
};

export function createD1ContentQueryClient(d1: D1Like): ContentQueryClient {
	return {
		async execute({ sql, args }) {
			const { results } = await d1.prepare(sql).bind(...args).all();
			return { rows: Array.isArray(results) ? results : [] };
		},
	};
}

/** True when `value` looks like a D1 binding (has `prepare`). */
export function isD1Like(value: unknown): value is D1Like {
	return typeof (value as { prepare?: unknown } | null)?.prepare === 'function';
}