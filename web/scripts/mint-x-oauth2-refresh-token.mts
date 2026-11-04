/**
 * One-shot OAuth 2.0 + PKCE helper: authorize an X account and print the refresh
 * token to paste into `.env.dev`.
 *
 * Production (default): reads X_CLIENT_ID / X_CLIENT_SECRET, prints X_REFRESH_TOKEN.
 * Staging test (`--test`): reads X_TEST_CLIENT_ID / X_TEST_CLIENT_SECRET, prints
 * X_TEST_REFRESH_TOKEN. Do not rename test keys onto production names.
 *
 * Prerequisites (console.x.com):
 * - OAuth 2.0 enabled on the app (confidential client)
 * - Callback URL exactly: http://127.0.0.1:9876/callback
 *   (8787 is often taken by local proxies on this machine)
 * - Matching client id/secret already in repo-root `.env.dev`
 *
 * Usage (from repo root or web/):
 *   npx tsx web/scripts/mint-x-oauth2-refresh-token.mts
 *   npx tsx web/scripts/mint-x-oauth2-refresh-token.mts --test
 *
 * Does not post tweets. Does not print the client secret.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CALLBACK_PORT = 9876;
const CALLBACK = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const AUTH = 'https://twitter.com/i/oauth2/authorize';
const TOKEN = 'https://api.x.com/2/oauth2/token';
const SCOPES = 'tweet.read tweet.write users.read offline.access';

function repoRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, '../..');
}

function readEnvDev(): Record<string, string> {
	const path = resolve(repoRoot(), '.env.dev');
	if (!existsSync(path)) throw new Error(`Missing ${path}`);
	const out: Record<string, string> = {};
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith('#') || !t.includes('=')) continue;
		const i = t.indexOf('=');
		out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
	}
	return out;
}

function b64url(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pkce(): { verifier: string; challenge: string } {
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash('sha256').update(verifier).digest());
	return { verifier, challenge };
}

async function main(): Promise<void> {
	const useTest = process.argv.includes('--test');
	const env = readEnvDev();
	const clientIdKey = useTest ? 'X_TEST_CLIENT_ID' : 'X_CLIENT_ID';
	const clientSecretKey = useTest ? 'X_TEST_CLIENT_SECRET' : 'X_CLIENT_SECRET';
	const refreshKey = useTest ? 'X_TEST_REFRESH_TOKEN' : 'X_REFRESH_TOKEN';
	const clientId = env[clientIdKey]?.trim();
	const clientSecret = env[clientSecretKey]?.trim();
	if (!clientId || !clientSecret) {
		throw new Error(
			`Set ${clientIdKey} and ${clientSecretKey} in .env.dev first (from console.x.com OAuth 2.0 keys).` +
				(useTest ? '' : ' For the staging test app, pass --test instead of renaming keys.'),
		);
	}

	const state = b64url(randomBytes(16));
	const { verifier, challenge } = pkce();
	const authorize = new URL(AUTH);
	authorize.searchParams.set('response_type', 'code');
	authorize.searchParams.set('client_id', clientId);
	authorize.searchParams.set('redirect_uri', CALLBACK);
	authorize.searchParams.set('scope', SCOPES);
	authorize.searchParams.set('state', state);
	authorize.searchParams.set('code_challenge', challenge);
	authorize.searchParams.set('code_challenge_method', 'S256');

	const who = useTest ? 'the X staging test account' : 'the Freedom Times X account';
	console.log(`Mode: ${useTest ? 'staging test (--test)' : 'production'}`);
	console.log('1. In console.x.com → your app → User authentication settings:');
	console.log(`   Callback URI / Redirect URL: ${CALLBACK}`);
	console.log('   Type of App: Web App (confidential)');
	console.log(`2. Open this URL while signed in as ${who}:\n\n${authorize.toString()}\n`);
	console.log(`Waiting for callback on 127.0.0.1:${CALLBACK_PORT} …`);

	const code = await new Promise<string>((resolveCode, reject) => {
		const server = createServer(async (req, res) => {
			try {
				const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);
				if (url.pathname !== '/callback') {
					res.writeHead(404).end('not found');
					return;
				}
				const err = url.searchParams.get('error');
				if (err) throw new Error(`X authorize error: ${err} ${url.searchParams.get('error_description') ?? ''}`);
				const gotState = url.searchParams.get('state');
				if (gotState !== state) throw new Error('state mismatch');
				const authCode = url.searchParams.get('code');
				if (!authCode) throw new Error('missing code');
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				res.end('<p>OK — return to the terminal. You can close this tab.</p>');
				server.close();
				resolveCode(authCode);
			} catch (e) {
				res.writeHead(400).end(String(e));
				server.close();
				reject(e);
			}
		});
		server.on('error', reject);
		server.listen(CALLBACK_PORT, '127.0.0.1');
	});

	const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: CALLBACK,
		code_verifier: verifier,
	});
	const tokenRes = await fetch(TOKEN, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			authorization: `Basic ${basic}`,
		},
		body,
	});
	const json = (await tokenRes.json()) as Record<string, unknown>;
	if (!tokenRes.ok) {
		throw new Error(`token exchange failed HTTP ${tokenRes.status}: ${JSON.stringify({ error: json.error, error_description: json.error_description })}`);
	}
	const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : '';
	if (!refresh) {
		throw new Error('No refresh_token in response — ensure scope includes offline.access');
	}
	console.log('\nPaste into .env.dev (do not commit):\n');
	console.log(`${refreshKey}=${refresh}`);
	console.log('\nThen sync to the Worker:');
	if (useTest) {
		console.log('  pwsh ./scripts/set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets');
	} else {
		console.log('  pwsh ./scripts/set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets -AllowProduction');
	}
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
