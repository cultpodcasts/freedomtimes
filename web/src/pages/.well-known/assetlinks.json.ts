import type { APIRoute } from 'astro';

/**
 * Android Digital Asset Links for package `news.freedomtimes.app`.
 *
 * Served at `/.well-known/assetlinks.json` (AUTH_BYPASS under `/.well-known/`).
 * Without this route, unknown `/.well-known/*` paths hit EmDash and return Worker 1101.
 *
 * Fingerprints (SHA-256, colon-separated, from keytool / apksigner):
 * - Android debug keystore (`~/.android/debug.keystore`, alias androiddebugkey)
 * - Staging signing keystore (`ANDROID_STAGING_SIGNING_*`, alias freedomtimes-staging)
 *
 * Verified 2026-07-18 from the last successful Capacitor Android CI artifact
 * (`capacitor-android-debug-apk`, run 24776062850, 2026-04-22): Signer DN
 * `CN=Freedom Times Staging…`, SHA-256 matches the staging fingerprint below.
 * CI only runs `assembleDebug` with staging secrets — there is no separate
 * production-signed APK/AAB on GitHub. Local/release builds that fall back to
 * the staging keystore also match that fingerprint.
 *
 * Still needed later (not extractable from the CI APK):
 * - `ANDROID_PRODUCTION_SIGNING_*` cert SHA-256 when a dedicated upload/production
 *   keystore is configured (add a third fingerprint below).
 * - Google Play App Signing cert from Play Console if store installs are re-signed
 *   by Google (add that fingerprint too; upload-key alone is not enough for Play).
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
        // Local default debug keystore
        '7E:D8:41:B4:BA:4B:F3:C6:F4:77:09:66:48:F6:3E:CB:F2:A2:94:B0:FB:B4:C0:15:6B:78:8D:DA:E9:B3:6B:1E',
        // Staging signing + CI/sideload APKs (verified from GH run 24776062850)
        'D9:A6:A7:73:0F:F0:6F:ED:F6:B3:41:0C:4A:F0:3A:48:58:71:63:8F:E3:49:C7:28:79:F5:12:98:B4:6F:14:60',
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
