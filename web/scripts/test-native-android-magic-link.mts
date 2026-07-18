import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isCapacitorAndroidMagicLinkRequest,
  resolveAndroidMagicLinkHttpsUrl,
  resolveMagicLinkLanderToHttpsVerify,
  toAndroidMagicLinkDeepLink,
  toAndroidMagicLinkLanderUrl,
  wrapMagicLinkEmailForAndroidRequest,
} from '../src/lib/native-android-magic-link.ts';
import {
  CAPACITOR_LAUNCH_URL_HANDLED_KEY,
  claimCapacitorLaunchUrl,
} from '../src/lib/native-launch-url.ts';

describe('native-android-magic-link', () => {
  it('builds deep link with token and ft_origin', () => {
    const https =
      'https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=abc123';
    const deep = toAndroidMagicLinkDeepLink(https);
    assert.equal(
      deep,
      'news.freedomtimes.app://auth/magic-link/verify?token=abc123&ft_origin=https%3A%2F%2Ffreedomtimes.news',
    );
  });

  it('builds HTTPS lander URL with token and ft_origin', () => {
    const https =
      'https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=abc123';
    const lander = toAndroidMagicLinkLanderUrl(https);
    assert.equal(
      lander,
      'https://freedomtimes.news/auth/native-magic-link?token=abc123&ft_origin=https%3A%2F%2Ffreedomtimes.news',
    );
  });

  it('resolves deep link back to HTTPS verify', () => {
    const deep =
      'news.freedomtimes.app://auth/magic-link/verify?token=abc123&ft_origin=https%3A%2F%2Ffreedomtimes.news';
    const https = resolveAndroidMagicLinkHttpsUrl(deep, 'https://staging.freedomtimes.news');
    assert.equal(
      https,
      'https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=abc123',
    );
  });

  it('resolves HTTPS lander App Link to verify', () => {
    const lander =
      'https://freedomtimes.news/auth/native-magic-link?token=abc123&ft_origin=https%3A%2F%2Ffreedomtimes.news';
    const https = resolveMagicLinkLanderToHttpsVerify(lander, 'https://staging.freedomtimes.news');
    assert.equal(
      https,
      'https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=abc123',
    );
  });

  it('detects Capacitor Android via ft_native_android cookie', () => {
    const request = new Request('https://freedomtimes.news/_emdash/api/auth/magic-link/send', {
      method: 'POST',
      headers: { cookie: 'ft_native_android=1; other=x' },
    });
    assert.equal(isCapacitorAndroidMagicLinkRequest(request), true);
  });

  it('does not treat bare Android Chrome UA as Capacitor', () => {
    const request = new Request('https://freedomtimes.news/_emdash/api/auth/magic-link/send', {
      method: 'POST',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
      },
    });
    assert.equal(isCapacitorAndroidMagicLinkRequest(request), false);
  });

  it('rewrites email HTML Sign-in href to HTTPS lander for Capacitor Android', () => {
    const request = new Request('https://freedomtimes.news/_emdash/api/auth/magic-link/send', {
      method: 'POST',
      headers: { cookie: 'ft_native_android=1' },
    });
    const html = `
      <a href="https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=tok">Sign in</a>
    `;
    const out = wrapMagicLinkEmailForAndroidRequest({ to: 'a@b.c', subject: 'x', html }, request);
    assert.match(
      out.html ?? '',
      /https:\/\/freedomtimes\.news\/auth\/native-magic-link\?token=tok&ft_origin=https%3A%2F%2Ffreedomtimes\.news/,
    );
    assert.doesNotMatch(out.html ?? '', /news\.freedomtimes\.app:\/\//);
    assert.doesNotMatch(out.html ?? '', /href="https:\/\/freedomtimes\.news\/_emdash/);
  });

  it('leaves HTTPS verify links for non-native requests', () => {
    const request = new Request('https://freedomtimes.news/_emdash/api/auth/magic-link/send', {
      method: 'POST',
    });
    const html =
      '<a href="https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=tok">Sign in</a>';
    const out = wrapMagicLinkEmailForAndroidRequest({ to: 'a@b.c', subject: 'x', html }, request);
    assert.equal(out.html, html);
  });
});

describe('claimCapacitorLaunchUrl', () => {
  it('allows the first claim and blocks the same URL afterward', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const url =
      'https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=once';
    assert.equal(claimCapacitorLaunchUrl(url, storage), true);
    assert.equal(store.get(CAPACITOR_LAUNCH_URL_HANDLED_KEY), url);
    assert.equal(claimCapacitorLaunchUrl(url, storage), false);
  });

  it('allows a different launch URL after the first', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    assert.equal(
      claimCapacitorLaunchUrl(
        'https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=a',
        storage,
      ),
      true,
    );
    assert.equal(
      claimCapacitorLaunchUrl(
        'https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=b',
        storage,
      ),
      true,
    );
  });
});
