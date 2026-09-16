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
		assert.equal(content[0].url, mp4);
		assert.equal(content[0].id, mp4);
		assert.equal(content[0].captionsUrl, vtt);
		assert.equal(content[0].captionsDefaultOn, true);
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
