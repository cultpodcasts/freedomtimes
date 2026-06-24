/** @typedef {'very-low' | 'low' | 'normal' | 'high'} PushUrgency */

/**
 * @typedef {object} PushNotificationPayload
 * @property {string} title
 * @property {string} body
 * @property {string} url
 * @property {string} icon
 * @property {string} badge
 * @property {string} tag
 * @property {number} ttl
 * @property {PushUrgency} urgency
 * @property {string} [image]
 */

/** @typedef {{ platform: 'web'; endpoint: string; keys: { p256dh: string; auth: string } }} PushTarget */
/** @typedef {{ platform: 'android'; token: string }} AndroidPushTarget */
/** @typedef {{ platform: 'ios'; token: string }} IosPushTarget */
/** @typedef {PushTarget | AndroidPushTarget | IosPushTarget} StoredNotificationTarget */

/** @typedef {{ ok: boolean; deactivate: boolean; reason?: string }} DeliveryResult */

/** @typedef {{ publicKey: string; privateKey: string; subject: string }} WebPushConfig */
/** @typedef {{ projectId: string; clientEmail: string; privateKey: string; channelId: string }} AndroidPushConfig */
/** @typedef {{ teamId: string; keyId: string; privateKey: string; bundleId: string; host: string }} IosPushConfig */

export {};
