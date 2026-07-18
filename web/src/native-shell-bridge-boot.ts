/**
 * Standalone boot for Capacitor native auth on pages that do not use Layout.astro
 * (EmDash admin / login). Built to `public/native-shell-bridge.js` and injected by
 * middleware into `/_emdash` HTML so warm App Links still `location.replace` the
 * lander/verify URL while the WebView is stuck on “Check your email”.
 */
import { initializeNativeAuthBridge } from './lib/native-auth-bridge';

void initializeNativeAuthBridge();
