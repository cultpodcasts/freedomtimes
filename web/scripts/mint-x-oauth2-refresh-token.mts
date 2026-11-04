/**
 * One-shot OAuth 2.0 + PKCE helper: authorize the Freedom Times X account and
 * print the refresh token to paste into `.env.dev` as X_REFRESH_TOKEN.
 *
 * Prerequisites (console.x.com, signed in as @_freedomtimes):
 * - OAuth 2.0 enabled on the app (confidential client)
 * - Callback URL exactly: http://127.0.0.1:9876/callback
 *   (8787 is often taken by local proxies on this machine)
 * - X_CLIENT_ID and X_CLIENT_SECRET already in repo-root `.env.dev`
 *
 * Usage (from repo root or web/):
 *   npx tsx web/scripts/mint-x-oauth2-refresh-token.mts
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
	const env = readEnvDev();
	const clientId = env.X_CLIENT_ID?.trim();
	const clientSecret = env.X_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) {
		throw new Error('Set X_CLIENT_ID and X_CLIENT_SECRET in .env.dev first (from console.x.com OAuth 2.0 keys).');
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

	console.log('1. In console.x.com → your app → User authentication settings:');
	console.log(`   Callback URI / Redirect URL: ${CALLBACK}`);
	console.log('   Type of App: Web App (confidential)');
	console.log(`2. Open this URL while signed in as the Freedom Times X account:\n\n${authorize.toString()}\n`);
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
	console.log(`X_REFRESH_TOKEN=${refresh}`);
	console.log('\nThen sync to the production Worker:');
	console.log('  pwsh ./scripts/set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets -AllowProduction');
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
