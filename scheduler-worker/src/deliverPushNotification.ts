/**
 * Type surface for shared push delivery (implementation in shared/push/deliverPushNotification.mjs).
 */
import type { PushNotificationPayload } from './articleNotificationPayload';

export type {
	PushNotificationPayload,
};

export type PushTarget = {
	platform: 'web';
	endpoint: string;
	keys: {
		p256dh: string;
		auth: string;
	};
};

export type AndroidPushTarget = {
	platform: 'android';
	token: string;
};

export type IosPushTarget = {
	platform: 'ios';
	token: string;
};

export type StoredNotificationTarget = PushTarget | AndroidPushTarget | IosPushTarget;

export type DeliveryResult = {
	ok: boolean;
	deactivate: boolean;
	reason?: string;
};

export type WebPushConfig = {
	publicKey: string;
	privateKey: string;
	subject: string;
};

export type AndroidPushConfig = {
	projectId: string;
	clientEmail: string;
	privateKey: string;
	channelId: string;
};

export type IosPushConfig = {
	teamId: string;
	keyId: string;
	privateKey: string;
	bundleId: string;
	host: string;
};

export {
	parseStoredTarget,
	deliverToStoredTarget,
	readWebPushConfig,
	readAndroidPushConfig,
	readIosPushConfig,
	createApplicationServerKeys,
	createGoogleAccessToken,
	createApnsToken,
	DEFAULT_ANDROID_CHANNEL_ID,
	DEFAULT_IOS_APNS_HOST,
} from '../../shared/push/deliverPushNotification.mjs';
