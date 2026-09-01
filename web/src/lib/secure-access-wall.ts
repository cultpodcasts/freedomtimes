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
 */
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
