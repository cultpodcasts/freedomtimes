import { ApplicationServerKeys } from 'webpush-webcrypto';

const subject = process.argv[2] || 'mailto:platform@freedomtimes.news';
const keys = await ApplicationServerKeys.generate();
const serialized = await keys.toJSON();

console.log('# Staging');
console.log(`PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY=${serialized.publicKey}`);
console.log(`PUSH_STAGING_VAPID_PRIVATE_KEY=${serialized.privateKey}`);
console.log(`PUSH_STAGING_VAPID_SUBJECT=${subject}`);
console.log('');
console.log('# Production');
console.log(`PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY=${serialized.publicKey}`);
console.log(`PUSH_PRODUCTION_VAPID_PRIVATE_KEY=${serialized.privateKey}`);
console.log(`PUSH_PRODUCTION_VAPID_SUBJECT=${subject}`);