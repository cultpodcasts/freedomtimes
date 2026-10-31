/**
 * Android staging/production switch (#149): the editor-only page's view logic, the server gate,
 * and the native wiring (indicator, push reset, origin check) all line up.
 * Run: npx tsx --test scripts/test-android-app-environment.mts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
	APP_ENVIRONMENT_PATH,
	describeSwitchResult,
	planAppEnvironmentView,
	shouldRevealAppEnvironmentLink,
} from '../src/lib/app-environment-switch.ts';

const web = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, web), 'utf8');
const java = (name: string) => read(`android/app/src/main/java/news/freedomtimes/app/${name}.java`);

test('the page offers the other environment only in a switchable Android app', () => {
	assert.deepEqual(planAppEnvironmentView({ kind: 'not-android-app' }).target, null);
	assert.deepEqual(planAppEnvironmentView({ kind: 'unsupported-app' }).target, null);
	assert.equal(
		planAppEnvironmentView({ kind: 'native', value: { environment: 'production', switchable: false } }).target,
		null,
	);
	assert.equal(
		planAppEnvironmentView({ kind: 'native', value: { environment: 'custom', switchable: true } }).target,
		null,
	);

	const onProduction = planAppEnvironmentView({ kind: 'native', value: { environment: 'production', switchable: true } });
	assert.equal(onProduction.target, 'staging');
	assert.equal(onProduction.buttonLabel, 'Switch to staging');
	assert.match(onProduction.status, /Production/);

	const onStaging = planAppEnvironmentView({ kind: 'native', value: { environment: 'staging', switchable: true } });
	assert.equal(onStaging.target, 'production');
	assert.equal(onStaging.buttonLabel, 'Switch to production');
	assert.match(onStaging.status, /Staging/);
});

test('switch results read sensibly', () => {
	assert.match(describeSwitchResult('staging', { switched: true, reason: 'switched' }), /Secure Access/);
	assert.match(describeSwitchResult('production', { switched: true, reason: 'switched' }), /production/);
	assert.equal(describeSwitchResult('staging', { switched: false, reason: 'cancelled' }), 'No change.');
	assert.match(describeSwitchResult('staging', { switched: false, reason: 'push_reset_failed' }), /notifications/);
	assert.match(describeSwitchResult('staging', { switched: false, reason: 'error' }), /Try again/);
});

test('header link: Android app only', () => {
	assert.equal(shouldRevealAppEnvironmentLink(true, 'android'), true);
	assert.equal(shouldRevealAppEnvironmentLink(true, 'ios'), false);
	assert.equal(shouldRevealAppEnvironmentLink(false, 'web'), false);
});

test('the switcher page is server-gated to admin/editor and the header link is staff-only', () => {
	const page = read('src/pages/app-environment.astro');
	assert.match(page, /requireAdminPageSession/);
	assert.match(page, /roleCheck: hasEditorialRole/);
	assert.match(page, /noindex=\{true\}/);
	assert.match(page, /if \(auth instanceof Response\) \{\s+return auth;/);
	assert.match(read('src/lib/page-cache-policy.ts'), /'app-environment',/, 'never served from the page cache');

	const header = read('src/components/Header.astro');
	const signedInBranch = header.slice(header.indexOf('{isSignedIn ? ('), header.indexOf(') : ('));
	assert.match(signedInBranch, /href="\/app-environment"[^>]*hidden/, 'rendered only for signed-in staff, hidden until revealed');
	assert.equal(header.split('href="/app-environment"').length, 2, 'one link, inside the signed-in branch');
	assert.match(header, /shouldRevealAppEnvironmentLink\(Capacitor\.isNativePlatform\(\), Capacitor\.getPlatform\(\)\)/);
});

test('native switch accepts requests only from the same switcher path', () => {
	assert.match(java('AppEnvironmentPolicy'), new RegExp(`SWITCHER_PATH = "${APP_ENVIRONMENT_PATH}"`));
	const plugin = java('NativeAppConfigPlugin');
	assert.match(plugin, /AppEnvironmentPolicy\.isSwitchRequestAllowed\(pageUrl, active, target\)/);
	assert.match(plugin, /public void getEnvironment\(PluginCall call\)/);
	assert.match(plugin, /public void requestEnvironmentSwitch\(PluginCall call\)/);
	const types = read('src/lib/native-app-config.ts');
	assert.match(types, /registerPlugin<NativeAppConfigPlugin>\('NativeAppConfig'\)/);
	assert.doesNotMatch(read('src/lib/device-notifications.ts'), /registerPlugin<NativeAppConfigPlugin>/, 'registered once');
});

test('activity wiring: config before the bridge, indicator after it, defaults to production', () => {
	const activity = java('MainActivity');
	const resolve = activity.indexOf('AppEnvironmentConfig.resolve(this)');
	const superCreate = activity.indexOf('super.onCreate(savedInstanceState)');
	const indicator = activity.indexOf('StagingIndicator.install(this, getBridge(), activeEnvironment, environmentSwitchable)');
	assert.ok(resolve > 0 && resolve < superCreate, 'server URL is chosen before BridgeActivity creates the bridge');
	assert.ok(indicator > superCreate, 'indicator is installed over the created WebView');
	assert.ok(activity.indexOf('WebViewPullToRefresh.install(this, getBridge())') > superCreate, '#150 still installed');
	assert.match(java('AppEnvironment'), /return env == null \? PRODUCTION : env;/);
	assert.match(java('AppEnvironmentStore'), /\.commit\(\)/);
});

test('push never crosses environments: the FCM token is deleted before the switch', () => {
	const switcher = java('AppEnvironmentSwitcher');
	assert.match(switcher, /FirebaseMessaging\.getInstance\(\)\.deleteToken\(\)/);
	const reset = switcher.indexOf('resetPushToken(activity.getApplicationContext()');
	const store = switcher.indexOf('AppEnvironmentStore.set(activity, target)');
	assert.ok(reset > 0 && reset < store, 'token reset comes before the choice is saved');
	assert.match(switcher, /if \(!ok\) \{[\s\S]*?push_reset_failed[\s\S]*?return;/, 'a failed reset cancels the switch');
	assert.match(read('android/app/build.gradle'), /com\.google\.firebase:firebase-messaging:\$firebaseMessagingVersion/);
});

test('indicator is native, outside the WebView, with no close control', () => {
	const indicator = java('StagingIndicator');
	assert.match(indicator, /findViewById\(android\.R\.id\.content\)/);
	assert.match(indicator, /AppEnvironmentPolicy\.shouldShowStagingIndicator\(active, url\)/);
	assert.match(indicator, /onPageStarted/);
	assert.match(indicator, /onPageCommitVisible/);
	assert.doesNotMatch(indicator, /removeView|\.dismiss\(|onClose|swipe/i, 'no way to remove or swipe it away');
	assert.equal(indicator.split('banner.setVisibility(').length, 3, 'only build (GONE) and update() change visibility');
	assert.match(read('android/app/src/main/res/values/strings.xml'), /name="staging_indicator_label">STAGING/);
});

test('the Android CI runs these tests', () => {
	const workflow = readFileSync(new URL('../.github/workflows/capacitor-android.yml', web), 'utf8');
	assert.match(workflow, /scripts\/test-android-app-environment\.mts/);
	assert.match(workflow, /\.\/gradlew testDebugUnitTest assembleDebug/);
});
