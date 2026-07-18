# Android Capacitor builds (staging vs production)

This project’s Android shell loads the site from a **live URL** configured at sync time via `CAPACITOR_SERVER_URL` (see `web/capacitor.config.ts`). Use the helper script so the URL, Capacitor assets, and Gradle build stay aligned.

## Script

From the **repository root**:

```powershell
.\scripts\build-android-capacitor.ps1 -BuildType Debug -Target Staging
.\scripts\build-android-capacitor.ps1 -BuildType Release -Target Production
```

### Parameters

| Parameter | Values | Default | Purpose |
|-----------|--------|---------|---------|
| `-BuildType` | `Debug`, `Release` | `Debug` | Gradle task: `assembleDebug` or `assembleRelease`. |
| `-Target` | `Staging`, `Production` | `Staging` | Sets `CAPACITOR_SERVER_URL` to `https://staging.freedomtimes.news` or `https://freedomtimes.news`. |
| `-JavaHome` | Path to JDK root | `$env:JAVA_HOME` or common Android OpenJDK path | Must contain `bin\java.exe`. |
| `-SkipCapSync` | Switch | off | Skip `npm run cap:sync:android` (only run Gradle). |
| `-RefreshLauncherIcons` | Switch | off | Run `npm run android:launcher-icons` first (PNG launchers from `web/public/favicon.svg`). |

### What the script does

1. Sets `CAPACITOR_SERVER_URL` for the chosen **Target**.
2. Unless `-SkipCapSync`: runs `npm run cap:sync:android` in `web/` (updates `android/app/src/main/assets/capacitor.config.json` and web assets).
3. Runs `gradlew.bat assembleDebug` or `assembleRelease` in `web/android/`.
4. Prints the expected APK path when the file exists.

### APK output locations

- **Debug:** `web/android/app/build/outputs/apk/debug/app-debug.apk`
- **Release:** `web/android/app/build/outputs/apk/release/app-release.apk` if signing is configured, otherwise often `app-release-unsigned.apk` (see below).

## Prerequisites

- **Node:** dependencies installed in `web/` (`npm ci` or `npm install`).
- **JDK 21:** e.g. `C:\Program Files\Android\openjdk\jdk-21.0.8` — set `JAVA_HOME` or pass `-JavaHome`.
- **Android SDK:** `web/android/local.properties` with `sdk.dir=...` (see [LOCAL_DEV_REQUIREMENTS.md](../../LOCAL_DEV_REQUIREMENTS.md) § Android).
- **Firebase (push):** optional for building; required for FCM at runtime — `web/android/app/google-services.json` (gitignored).

## Local publish (GH Actions offline)

GitHub Actions is not publishing Android APKs right now — build and sideload locally from the repo root:

```powershell
# EmDash / magic-link tests against production host (recommended for prod Outlook links)
.\scripts\build-android-capacitor.ps1 -BuildType Debug -Target Production

# Or Cap WebView pointed at staging
.\scripts\build-android-capacitor.ps1 -BuildType Debug -Target Staging

adb install -r .\web\android\app\build\outputs\apk\debug\app-debug.apk
```

`-Target` only sets `CAPACITOR_SERVER_URL` (which origin the WebView loads). App Links verification for a `https://freedomtimes.news/...` VIEW always checks **production** `/.well-known/assetlinks.json`, regardless of `-Target`.

## Signing notes

- **Debug:** uses **`ANDROID_STAGING_SIGNING_*`** from repo-root `.env.dev` when all four are set; otherwise the default debug keystore (`%USERPROFILE%\.android\debug.keystore`).
- **Release:** uses **`ANDROID_PRODUCTION_SIGNING_*`** when all four are set; if not, **falls back to the same staging keystore** as debug so local `assembleRelease` produces a signed **`app-release.apk`** you can `adb install`. If neither staging nor production signing is configured, release stays **unsigned** (`app-release-unsigned.apk`) and install fails with errors like `INSTALL_PARSE_FAILED_NO_CERTIFICATES`.

### Do you need a new SHA in `assetlinks.json`?

**Yes if** the APK you install is signed with a cert whose SHA-256 is not already listed. **No new fingerprint is required** for the usual local path on this machine:

| Local signing situation | SHA-256 (already in assetlinks?) |
|-------------------------|----------------------------------|
| `.env.dev` has all four `ANDROID_STAGING_SIGNING_*` → debug **and** release (no prod keystore) use staging cert | `D9:A6:A7:73:…:14:60` — **yes** |
| Fallback default `~/.android/debug.keystore` (no staging secrets) | `7E:D8:41:B4:…:6B:1E` — **yes** (this workstation's debug cert matches) |
| Future `ANDROID_PRODUCTION_SIGNING_*` or Play App Signing cert | **must add** that SHA, then deploy Worker so `https://freedomtimes.news/.well-known/assetlinks.json` serves it |

Verified 2026-07-18: operator `.env.dev` has staging signing configured (so local `assembleDebug` signs with staging, not the debug keystore). Both fingerprints are already published in `assetlinks.json.ts`.

### Digital Asset Links (`assetlinks.json`)

`GET https://freedomtimes.news/.well-known/assetlinks.json` (and staging) publishes package `news.freedomtimes.app` with SHA-256 fingerprints for the default debug keystore and the staging signing cert (`ANDROID_STAGING_SIGNING_*` in repo-root `.env.dev`).

**CI / sideload APK (verified):** The Capacitor Android workflow only builds **debug** APKs signed with staging secrets (`ANDROID_STAGING_SIGNING_*`). The last successful artifact before Actions breakage — run [`24776062850`](https://github.com/cultpodcasts/freedomtimes/actions/runs/24776062850), artifact `capacitor-android-debug-apk` (2026-04-22) — fingerprints as:

| Field | Value |
|-------|--------|
| Signer DN | `CN=Freedom Times Staging, OU=Engineering, O=Freedom Times, L=London, ST=London, C=GB` |
| SHA-256 | `D9:A6:A7:73:0F:F0:6F:ED:F6:B3:41:0C:4A:F0:3A:48:58:71:63:8F:E3:49:C7:28:79:F5:12:98:B4:6F:14:60` |

That matches the staging fingerprint already in `web/src/pages/.well-known/assetlinks.json.ts`. There are **no** GitHub Releases and **no** production-signed APK/AAB artifacts. `ANDROID_PRODUCTION_SIGNING_*` is still placeholders in `.env.dev.example` (not set locally).

**When you later add a dedicated production/upload keystore:**

1. Put all four `ANDROID_PRODUCTION_SIGNING_*` values in `.env.dev` (and GitHub secrets if CI signs release APKs).
2. Extract SHA-256 (colon-separated, as keytool prints):

```powershell
# After materializing the JKS from ANDROID_PRODUCTION_SIGNING_KEYSTORE_BASE64:
keytool -list -v -keystore <prod.jks> -alias <ANDROID_PRODUCTION_SIGNING_KEY_ALIAS>
```

3. Add that fingerprint to `sha256_cert_fingerprints` in `web/src/pages/.well-known/assetlinks.json.ts` and deploy the Worker.

**Play App Signing caveat:** If the app is published via Google Play with Play App Signing enabled, store-installed builds are signed with Google’s **app signing key**, not necessarily the upload key / CI staging key. Copy the **App signing key certificate** SHA-256 from Play Console → App integrity and add it as another fingerprint. Until then, DAL only covers sideload/CI builds signed with the staging (or future upload) key.

Until a distinct production/Play cert is added, release builds that fall back to the **staging** keystore already match the staging fingerprint listed there. DAL verifies HTTPS App Links (`android:autoVerify="true"`). Custom scheme `news.freedomtimes.app://` is used for Auth0 (`…/auth/callback`) and for EmDash Capacitor Android magic links (`…/auth/magic-link/verify`). EmDash magic-link **delivery** does not need DAL; **opening** `https://freedomtimes.news/_emdash/...` in the app does. See [EMDASH_CLOUDFLARE_EMAIL.md](./EMDASH_CLOUDFLARE_EMAIL.md).

### App Links (HTTPS) — what is registered

`web/android/app/src/main/AndroidManifest.xml` registers:

```text
https://freedomtimes.news/*
https://staging.freedomtimes.news/*
```

with `android:autoVerify="true"` (package `news.freedomtimes.app`). Capacitor `server.allowNavigation` includes both hosts. On open, [`native-auth-bridge.ts`](../src/lib/native-auth-bridge.ts) navigates the WebView to the launched URL (required so EmDash magic-link verify runs in-app).

Outlook Safe Links wrap the URL through `*.safelinks.protection.outlook.com` first; registration **cannot** claim that initial click. After Safe Links, if navigation is already inside Firefox, App Links will not pull the session into the WebView. Long-press / copy-unwrap / Gmail / `adb` tests are the reliable ways to exercise App Links. Details: [EMDASH_CLOUDFLARE_EMAIL.md](./EMDASH_CLOUDFLARE_EMAIL.md).

### Verify App Links on a device

**Local Production target checklist**

1. **APK** — rebuild with the updated `AndroidManifest` App Links filter (below). Sideload does not need a new SHA: local `assembleDebug` with `.env.dev` `ANDROID_STAGING_SIGNING_*` uses staging cert `D9:A6:…:14:60`, already listed in live `https://freedomtimes.news/.well-known/assetlinks.json`. **No Worker redeploy required for fingerprints.**
2. **WebView JS** — `-Target Production` loads `https://freedomtimes.news`. The `native-auth-bridge` App Link → verify-URL navigation ships with the **site Worker**. Deploy production web when you want that handler live; until then the APK may open on App Link but not navigate to `/_emdash/api/auth/magic-link/verify?token=…`. Also deploy the launch-URL dedupe fix so `/admin` after a successful magic link does not re-consume the token (see [EMDASH_CLOUDFLARE_EMAIL.md](./EMDASH_CLOUDFLARE_EMAIL.md) § `getLaunchUrl`).

```powershell
# From repo root — Production Cap URL + debug APK (staging-signed when .env.dev secrets set)
.\scripts\build-android-capacitor.ps1 -BuildType Debug -Target Production
adb install -r .\web\android\app\build\outputs\apk\debug\app-debug.apk

# Confirm DAL statements already live (no redeploy needed for SHA)
curl.exe -sS https://freedomtimes.news/.well-known/assetlinks.json

# After install: domain verification (Android 12+)
adb shell pm get-app-links news.freedomtimes.app

# Cold-open an *unwrapped* magic-link path (fresh unused token; Safe Links wrappers skip App Links).
# Reusing a token already opened in Firefox / prefetched by Safe Links → login?error=invalid_link.
# See EMDASH_CLOUDFLARE_EMAIL.md § single-use + Safe Links.
adb shell am start -a android.intent.action.VIEW -d "https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=YOUR_FRESH_TOKEN"
```

Also: [Google Digital Asset Links tester](https://developers.google.com/digital-asset-links/tools/generator) — statement list → `https://freedomtimes.news`, package `news.freedomtimes.app`, fingerprint matching the **installed** APK’s signer (staging/debug for sideloads; Play App Signing cert for store builds).

If verification is `none` / `legacy_failure`, fingerprints or package mismatch — fix `assetlinks.json` and redeploy the Worker, or reinstall with the matching keystore. Firefox may still prompt or prefer the browser until the link is verified and the user chooses “always open in Freedom Times.”


## Launcher icons from `favicon.svg`

Regenerate mipmap launcher PNGs after changing `web/public/favicon.svg`:

```powershell
cd web
npm run android:launcher-icons
```

Or pass `-RefreshLauncherIcons` to `build-android-capacitor.ps1` so icons refresh before sync.

## Manual parity (no script)

Equivalent steps:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\openjdk\jdk-21.0.8'
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$env:CAPACITOR_SERVER_URL = 'https://staging.freedomtimes.news'   # or https://freedomtimes.news
cd web
npm run cap:sync:android
cd android
.\gradlew.bat assembleDebug
```

## Related docs

- [LOCAL_DEV_REQUIREMENTS.md](../../LOCAL_DEV_REQUIREMENTS.md) — SDK, `google-services.json`, Java.
- [web/README.md](../README.md) — Capacitor spike commands and iOS notes.
