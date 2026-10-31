import type {
	AppEnvironmentId,
	NativeAppEnvironment,
	NativeEnvironmentSwitchResult,
} from './native-app-config';

/**
 * View logic for the editor-only `/app-environment` page (#149). The page itself is server-gated
 * to Auth0 `admin`/`editor`; the native app also refuses switch requests from any other page.
 */
export const APP_ENVIRONMENT_PATH = '/app-environment';

export const APP_ENVIRONMENT_LABELS: Record<AppEnvironmentId, string> = {
	production: 'Production (freedomtimes.news)',
	staging: 'Staging (staging.freedomtimes.news)',
};

export type AppEnvironmentView = {
	status: string;
	/** Null hides the switch button. */
	target: AppEnvironmentId | null;
	buttonLabel: string | null;
};

export type AppEnvironmentProbe =
	| { kind: 'not-android-app' }
	| { kind: 'unsupported-app' }
	| { kind: 'native'; value: NativeAppEnvironment };

export function planAppEnvironmentView(probe: AppEnvironmentProbe): AppEnvironmentView {
	if (probe.kind === 'not-android-app') {
		return {
			status: 'Open this page in the Freedom Times Android app to switch it between production and staging.',
			target: null,
			buttonLabel: null,
		};
	}
	if (probe.kind === 'unsupported-app') {
		return {
			status: 'This version of the app can\'t switch environments. Install the latest build.',
			target: null,
			buttonLabel: null,
		};
	}

	const { environment, switchable } = probe.value;
	if (!switchable || (environment !== 'production' && environment !== 'staging')) {
		return {
			status: 'This app build is fixed to its build URL and can\'t switch environments.',
			target: null,
			buttonLabel: null,
		};
	}

	const target: AppEnvironmentId = environment === 'production' ? 'staging' : 'production';
	return {
		status: `This app is showing ${APP_ENVIRONMENT_LABELS[environment]}.`,
		target,
		buttonLabel: target === 'staging' ? 'Switch to staging' : 'Switch to production',
	};
}

export function describeSwitchResult(target: AppEnvironmentId, result: NativeEnvironmentSwitchResult): string {
	if (result.switched) {
		return target === 'staging'
			? 'Restarting on staging. Sign in through Secure Access to continue.'
			: 'Restarting on production.';
	}
	switch (result.reason) {
		case 'cancelled':
			return 'No change.';
		case 'already_active':
			return 'The app is already on that environment.';
		case 'push_reset_failed':
			return 'Couldn\'t reset notifications for the switch. Check your connection and try again.';
		default:
			return 'The switch didn\'t happen. Try again.';
	}
}

/** Header link: Android app only (iOS has no switch yet), and only rendered for signed-in staff. */
export function shouldRevealAppEnvironmentLink(isNative: boolean, platform: string): boolean {
	return isNative && platform === 'android';
}
