export type FtMwLogFields = {
	event: string;
	cfRay: string;
	pathname: string;
	elapsedMs: number;
	[key: string]: string | number | boolean | null | undefined;
};

/** Grep Worker tails for `[ft-mw]`. */
export function logFtMw(fields: FtMwLogFields): void {
	console.log('[ft-mw]', JSON.stringify(fields));
}

export function createFtMwLogger(params: {
	cfRay: string;
	pathname: string;
	startedAt: number;
}): (event: string, extra?: Record<string, string | number | boolean | null | undefined>) => void {
	return (event, extra = {}) => {
		logFtMw({
			event,
			cfRay: params.cfRay,
			pathname: params.pathname,
			elapsedMs: Math.round(performance.now() - params.startedAt),
			...extra,
		});
	};
}
