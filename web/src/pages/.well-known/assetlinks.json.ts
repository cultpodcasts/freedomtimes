import type { APIRoute } from 'astro';

/**
 * Android Digital Asset Links for package `news.freedomtimes.app`.
 *
 * Served at `/.well-known/assetlinks.json` (AUTH_BYPASS under `/.well-known/`).
 * Without this route, unknown `/.well-known/*` paths hit EmDash and return Worker 1101.
 *
 * Fingerprints (SHA-256, colon-separated, from keytool):
 * - Android debug keystore (`~/.android/debug.keystore`, alias androiddebugkey)
 * - Staging signing keystore (`ANDROID_STAGING_SIGNING_*` in `.env.dev`, alias freedomtimes-staging)
 *
 * TODO(operator): add the production release signing cert SHA-256 when
 * `ANDROID_PRODUCTION_SIGNING_*` is configured. Until then, release APKs that
 * fall back to the staging keystore match the staging fingerprint below.
 *
 * Empty or wrong fingerprints do not break browser PWA, Auth0 `/admin`, EmDash,
 * custom-scheme deep links (`news.freedomtimes.app://auth/callback`), or Email Routing.
 * They only fail Android App Links / DAL verification until corrected.
 */
const ASSET_LINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'news.freedomtimes.app',
      sha256_cert_fingerprints: [
        // Local debug builds
        '7E:D8:41:B4:BA:4B:F3:C6:F4:77:09:66:48:F6:3E:CB:F2:A2:94:B0:FB:B4:C0:15:6B:78:8D:DA:E9:B3:6B:1E',
        // Staging / current release signing (ANDROID_STAGING_SIGNING_*)
        'D9:A6:A7:73:0F:F0:6F:ED:F6:B3:41:0C:4A:F0:3A:48:58:71:63:8F:E3:49:C7:28:79:F5:12:98:B4:6F:14:60',
        // TODO(operator): production release fingerprint from ANDROID_PRODUCTION_SIGNING_*
      ],
    },
  },
] as const;

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify(ASSET_LINKS, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
