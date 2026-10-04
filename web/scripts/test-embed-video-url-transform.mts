import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyTransforms, resolveTransforms } from './lib/pt-migrate/transforms/index.mjs';

const mp4 = '/_emdash/api/media/file/01M1MX4CVV7DK7CFFA64RKGWV5.mp4';
const vtt = '/_emdash/api/media/file/01M1PA7F09101YKXAH9P3RYWKG.vtt';
const transforms = resolveTransforms(['embed-video-url']);

describe('embed-video-url transform', () => {
	it('copies media-file id onto url and keeps captions extras', () => {
		const { content, changes } = applyTransforms(
			[
				{
					_type: 'embed',
					_key: 'jo344m8qj',
					provider: 'video',
					id: mp4,
					caption: 'Hall highlights',
					captionsUrl: vtt,
					captionsDefaultOn: true,
					captions: [{ url: vtt, srclang: 'en', label: 'English', default: true }],
				},
			],
			transforms,
		);
		assert.equal(changes.length, 1);
		const block = content[0];
		if (!block || typeof block !== 'object') {
			throw new Error('expected an embed block');
		}
		const record = block as Record<string, unknown>;
		assert.equal(record.url, mp4);
		assert.equal(record.id, mp4);
		assert.equal(record.captionsUrl, vtt);
		assert.equal(record.captionsDefaultOn, true);
	});

	it('does not rewrite when url is already a media path', () => {
		const { changes } = applyTransforms(
			[{ _type: 'embed', provider: 'video', url: mp4, id: 'other' }],
			transforms,
		);
		assert.equal(changes.length, 0);
	});

	it('ignores youtube-style id that is not a media path', () => {
		const { changes } = applyTransforms(
			[{ _type: 'embed', provider: 'video', id: 'dQw4w9wgGcQ' }],
			transforms,
		);
		assert.equal(changes.length, 0);
	});
});
