import { registerPlugin } from '@capacitor/core';

/**
 * The app's own native plugin (`NativeAppConfigPlugin.java`). Registered once here: Capacitor
 * plugins must not be registered twice.
 */
export type AppEnvironmentId = 'production' | 'staging';

export type NativeAppEnvironment = {
	/** `custom` for a local dev build whose URL is not a Freedom Times origin. */
	environment: AppEnvironmentId | 'custom';
	switchable: boolean;
};

export type NativeEnvironmentSwitchResult = {
	switched: boolean;
	reason: string;
};

export type NativeAppConfigPlugin = {
	getFirebaseStatus: () => Promise<{ firebaseConfigured: boolean }>;
	/** Android app builds with #149. Older builds reject (method not implemented). */
	getEnvironment: () => Promise<NativeAppEnvironment>;
	/** Android, #149: native confirm, then the app restarts on the chosen site. */
	requestEnvironmentSwitch: (options: { environment: AppEnvironmentId }) => Promise<NativeEnvironmentSwitchResult>;
};

export const nativeAppConfig = registerPlugin<NativeAppConfigPlugin>('NativeAppConfig');
