import assert from 'node:assert/strict';
import { parseImageDimensions, assessImageQuality, IMAGE_USAGE_TARGETS } from '../src/imageQuality.ts';

// Minimal 1×1 PNG
const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

assert.equal(parseImageDimensions(png1x1).width, 1);
assert.equal(parseImageDimensions(png1x1).height, 1);

const excellent = assessImageQuality({ width: 1920, height: 1080, bytes: 240_000, mimeType: 'image/jpeg' });
assert.equal(excellent.tier, 'excellent');
assert.equal(excellent.recommendation, 'use-as-is');

const lowRes = assessImageQuality({ width: 480, height: 320, bytes: 18_000, mimeType: 'image/jpeg' });
assert.equal(lowRes.tier, 'poor');
assert.equal(lowRes.recommendation, 'unsuitable');

const ogCrop = assessImageQuality(
  { width: 1200, height: 630, bytes: 90_000, mimeType: 'image/jpeg' },
  { source: 'og:image' },
);
assert.ok(ogCrop.warnings.some((w) => w.includes('social')));
assert.equal(ogCrop.tier, 'excellent');

const huge = assessImageQuality({ width: 4000, height: 3000, bytes: 4_000_000, mimeType: 'image/jpeg' });
assert.equal(huge.recommendation, 'reprocess');
assert.ok(huge.warnings.some((w) => w.includes('recompress')));

const marginal = assessImageQuality({ width: 640, height: 480, bytes: 55_000, mimeType: 'image/jpeg' });
assert.equal(marginal.tier, 'marginal');
assert.equal(marginal.recommendation, 'acceptable');

assert.equal(IMAGE_USAGE_TARGETS.articleWidth, 900);

console.log('image-quality.test.mts: ok');
