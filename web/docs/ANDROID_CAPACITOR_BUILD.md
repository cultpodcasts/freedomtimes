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

## Signing notes

- **Debug:** uses **`ANDROID_STAGING_SIGNING_*`** from repo-root `.env.dev` when all four are set; otherwise the default debug keystore.
- **Release:** uses **`ANDROID_PRODUCTION_SIGNING_*`** when all four are set; if not, **falls back to the same staging keystore** as debug so local `assembleRelease` produces a signed **`app-release.apk`** you can `adb install`. If neither staging nor production signing is configured, release stays **unsigned** (`app-release-unsigned.apk`) and install fails with errors like `INSTALL_PARSE_FAILED_NO_CERTIFICATES`.

### Digital Asset Links (`assetlinks.json`)

`GET https://freedomtimes.news/.well-known/assetlinks.json` (and staging) publishes package `news.freedomtimes.app` with SHA-256 fingerprints for the debug keystore and staging signing cert (`ANDROID_STAGING_SIGNING_*` in repo-root `.env.dev`).

**Production fingerprint:** not in the file yet — `ANDROID_PRODUCTION_SIGNING_*` is not configured locally (placeholders in `.env.dev.example`). When you have a production keystore:

1. Put all four `ANDROID_PRODUCTION_SIGNING_*` values in `.env.dev` (and GitHub secrets if CI signs release APKs).
2. Extract SHA-256 (colon-separated, as keytool prints):

```powershell
# After materializing the JKS from ANDROID_PRODUCTION_SIGNING_KEYSTORE_BASE64:
keytool -list -v -keystore <prod.jks> -alias <ANDROID_PRODUCTION_SIGNING_KEY_ALIAS>
```

3. Add that fingerprint to `sha256_cert_fingerprints` in `web/src/pages/.well-known/assetlinks.json.ts` and deploy the Worker.

Until then, release builds that fall back to the **staging** keystore already match the staging fingerprint listed there. DAL is for verified HTTPS App Links / WebView credential association — **not** required for browser PWA, Auth0 custom-scheme auth, or EmDash magic links. See [EMDASH_CLOUDFLARE_EMAIL.md](./EMDASH_CLOUDFLARE_EMAIL.md).


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
