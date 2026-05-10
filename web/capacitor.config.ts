import { CapacitorConfig } from '@capacitor/cli';

import { SITE_DISPLAY_NAME } from './src/lib/site-brand';

const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim() || 'https://staging.freedomtimes.news';
const usesCleartext = serverUrl.startsWith('http://');

function resolveAppendedUserAgent(): string {
  const npmEvent = (process.env.npm_lifecycle_event ?? '').toLowerCase();
  const argv = process.argv.map((value) => value.toLowerCase());

  const targetsAndroid = npmEvent.includes('android') || argv.includes('android');
  const targetsIos = npmEvent.includes('ios') || argv.includes('ios');

  if (targetsAndroid && !targetsIos) {
    return 'FreedomTimesCapacitorApp/Android';
  }

  if (targetsIos && !targetsAndroid) {
    return 'FreedomTimesCapacitorApp/iOS';
  }

  return 'FreedomTimesCapacitorApp';
}

const appendedUserAgent = resolveAppendedUserAgent();

const config: CapacitorConfig = {
  appId: 'news.freedomtimes.app',
  appName: SITE_DISPLAY_NAME,
  webDir: 'cap-web',
  server: {
    url: serverUrl,
    cleartext: usesCleartext,
    androidScheme: usesCleartext ? 'http' : 'https',
    appendUserAgent: appendedUserAgent,
  },
  android: {
    allowMixedContent: usesCleartext,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;