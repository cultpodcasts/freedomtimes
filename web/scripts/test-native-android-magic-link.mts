import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isCapacitorAndroidMagicLinkRequest,
  resolveAndroidMagicLinkHttpsUrl,
  toAndroidMagicLinkDeepLink,
  wrapMagicLinkEmailForAndroidRequest,
} from '../src/lib/native-android-magic-link.ts';

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

  it('resolves deep link back to HTTPS verify', () => {
    const deep =
      'news.freedomtimes.app://auth/magic-link/verify?token=abc123&ft_origin=https%3A%2F%2Ffreedomtimes.news';
    const https = resolveAndroidMagicLinkHttpsUrl(deep, 'https://staging.freedomtimes.news');
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

  it('rewrites email HTML Sign-in href for Capacitor Android', () => {
    const request = new Request('https://freedomtimes.news/_emdash/api/auth/magic-link/send', {
      method: 'POST',
      headers: { cookie: 'ft_native_android=1' },
    });
    const html = `
      <a href="https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=tok">Sign in</a>
    `;
    const out = wrapMagicLinkEmailForAndroidRequest({ to: 'a@b.c', subject: 'x', html }, request);
    assert.match(out.html ?? '', /news\.freedomtimes\.app:\/\/auth\/magic-link\/verify\?token=tok/);
    assert.doesNotMatch(out.html ?? '', /href="https:\/\/freedomtimes\.news\/_emdash/);
  });

  it('leaves HTTPS links for non-native requests', () => {
    const request = new Request('https://freedomtimes.news/_emdash/api/auth/magic-link/send', {
      method: 'POST',
    });
    const html =
      '<a href="https://freedomtimes.news/_emdash/api/auth/magic-link/verify?token=tok">Sign in</a>';
    const out = wrapMagicLinkEmailForAndroidRequest({ to: 'a@b.c', subject: 'x', html }, request);
    assert.equal(out.html, html);
  });
});
