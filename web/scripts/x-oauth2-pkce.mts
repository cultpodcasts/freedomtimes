/**
 * One-time OAuth 2.0 PKCE consent for @_freedomtimes (Stage B).
 * Prints an authorize URL, then exchanges the redirect code for a refresh token.
 * The token is printed once so Jon can store it with `wrangler secret put`.
 * This script does not post a tweet.
 *
 *   npx tsx scripts/x-oauth2-pkce.mts --client-id ID --redirect-uri https://example/callback
 *   npx tsx scripts/x-oauth2-pkce.mts --client-id ID --client-secret SECRET --redirect-uri URI --code CODE --verifier VERIFIER
 *
 * Pass the client secret only on the exchange step. Do not commit it.
 */
const SCOPES = 'tweet.read tweet.write users.read offline.access';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value || value.startsWith('--')) return undefined;
	return value;
}

function required(name: string): string {
	const value = arg(name);
	if (!value) throw new Error(`Missing --${name}`);
	return value;
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const clientId = required('client-id');
const redirectUri = required('redirect-uri');
const code = arg('code');

if (!code) {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	const challenge = base64url(new Uint8Array(digest));
	const url = new URL('https://x.com/i/oauth2/authorize');
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('scope', SCOPES);
	url.searchParams.set('state', base64url(crypto.getRandomValues(new Uint8Array(16))));
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	console.log('Open this URL while signed in as @_freedomtimes, approve access, then copy the code from the redirect.');
	console.log(url.toString());
	console.log(`code_verifier=${verifier}`);
	console.log('Then re-run with --code, --verifier, and --client-secret. Do not commit the output.');
	process.exit(0);
}

const clientSecret = required('client-secret');
const verifier = required('verifier');
const body = new URLSearchParams({
	grant_type: 'authorization_code',
	code,
	redirect_uri: redirectUri,
	code_verifier: verifier,
	client_id: clientId,
});
const response = await fetch(TOKEN_URL, {
	method: 'POST',
	headers: {
		authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
		'content-type': 'application/x-www-form-urlencoded',
	},
	body: body.toString(),
});
const json = (await response.json()) as { refresh_token?: string; error?: string; error_description?: string };
if (!response.ok || !json.refresh_token) {
	console.error(`Token exchange failed: HTTP ${response.status} ${json.error_description ?? json.error ?? ''}`);
	process.exit(1);
}
console.log('Put this value in the production secret X_OAUTH2_REFRESH_TOKEN. It will not be shown again.');
console.log(json.refresh_token);
