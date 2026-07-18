/**
 * Vite transform: wrap EmDash magic-link send so Capacitor Android emails use
 * `news.freedomtimes.app://auth/magic-link/verify?…` instead of HTTPS.
 *
 * Upstream `sendMagicLink` hardcodes:
 *   new URL("/_emdash/api/auth/magic-link/verify", config.baseUrl)
 * with no URL builder — see @emdash-cms/auth magic-link/index.ts.
 */
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const WRAP_HELPER = fileURLToPath(
  new URL('../lib/native-android-magic-link.ts', import.meta.url),
).replace(/\\/g, '/');

const EMAIL_ARROW_RE =
  /email:\s*\(message\)\s*=>\s*emdash\.email(?:!)?\.send\(message,\s*(["'])system\1\)/;

export function magicLinkAndroidSchemePlugin(): Plugin {
  return {
    name: 'freedomtimes:magic-link-android-scheme',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.replace(/\\/g, '/');
      if (
        !normalized.includes('/emdash/')
        || !normalized.includes('magic-link/send')
        || normalized.includes('node_modules/.vite')
      ) {
        return null;
      }

      if (!EMAIL_ARROW_RE.test(code)) {
        return null;
      }

      // Reset lastIndex after .test on a global-less regex (safe) / rebuild replace.
      const next = code.replace(
        EMAIL_ARROW_RE,
        'email: (message) => emdash.email.send(wrapMagicLinkEmailForAndroidRequest(message, request), "system")',
      );

      if (next === code) {
        return null;
      }

      const importLine =
        `import { wrapMagicLinkEmailForAndroidRequest } from ${JSON.stringify(WRAP_HELPER)};\n`;

      return {
        code: importLine + next,
        map: null,
      };
    },
  };
}
