/**
 * Locked staging's anonymous document. Always returned as a complete HTTP
 * Response — never composed in the same Astro template as HomepageView.
 *
 * Astro collects every `.astro` import's CSS onto the route. Putting the wall
 * component next to HomepageView on `/` made newsroom `html,body` rules win
 * after logout (serif type, no vertical center). A Response is the document
 * boundary; it does not include the newsroom stylesheet.
 *
 * Do not Astro.rewrite to `/login-wall` to compose two templates. The wall
 * is a Response so Homepage CSS cannot leak. After `supportsRequestScope`,
 * rewrite is not the hang mechanism (that was isolate-wide getDb).
 *
 * Native app (PR #198): the wall MUST load `/native-shell-bridge.js` (the standalone build of
 * native-auth-bridge.ts that Layout.astro pages get inline). Without it the Capacitor WebView
 * has no click interceptor, so "Log in with Google" navigated the WebView itself to Auth0 →
 * Google refuses OAuth inside a WebView (or, with a stale `ft_native_app` cookie, Auth0 redirects
 * to `news.freedomtimes.app://auth/callback` with no `appUrlOpen` listener to finish the login).
 * With the bridge the button opens Auth0 in the system browser (`/auth/login?native=1`) and the
 * custom-scheme callback is replayed to `/auth/callback` inside the WebView cookie jar, exactly
 * like production pages. The script is a static asset (served before the Worker, so the lock
 * does not block it) and is a no-op in a normal browser.
 */
export const SECURE_ACCESS_WALL_NATIVE_BRIDGE_SCRIPT =
	'<script src="/native-shell-bridge.js" defer data-ft-native-shell-bridge="1"></script>';

export function renderSecureAccessWallHtml(denied = false): string {
	const warn = denied
		? '<p class="warn">Access denied.</p>'
		: '';

	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>Secure Access</title>
		${SECURE_ACCESS_WALL_NATIVE_BRIDGE_SCRIPT}
		<link rel="preconnect" href="https://fonts.googleapis.com">
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
		<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
		<style>
			body {
				margin: 0;
				min-height: 100vh;
				display: grid;
				place-items: center;
				background: #ffffff;
				font-family: 'Inter', sans-serif;
				color: #111111;
			}
			.card {
				text-align: center;
				padding: 2rem;
				max-width: 400px;
			}
			.lead {
				margin-bottom: 2rem;
				color: #555555;
				font-size: 1.1rem;
			}
			.button {
				display: inline-block;
				padding: 1rem 2rem;
				background: #111111;
				color: #ffffff;
				text-decoration: none;
				font-weight: 700;
				border-radius: 4px;
				transition: background 0.2s;
			}
			.button:hover {
				background: #0044bb;
			}
			.warn {
				color: #cc0000;
				margin-bottom: 1rem;
				font-size: 0.9rem;
			}
		</style>
	</head>
	<body>
		<div class="card">
			<p class="lead">Secure Access</p>
			${warn}
			<a class="button" href="/auth/login">Log in with Google</a>
		</div>
	</body>
</html>
`;
}

export function secureAccessWallResponse(denied = false): Response {
	return new Response(renderSecureAccessWallHtml(denied), {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
		},
	});
}
