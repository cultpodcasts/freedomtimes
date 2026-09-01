/** Paths that get `[ft-mw]` structured logs for wrangler tail. */
export function shouldTraceFtMwPath(pathname: string): boolean {
	return pathname.startsWith('/posts/') || pathname === '/auth/login';
}

export function isHttpRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
