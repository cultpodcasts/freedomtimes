import {
	resolveSelfHostedVideoUrl,
	resolveVideoCaptionTracks,
} from '../src/lib/content/videoCaptionTracks.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const videoUrl = '/_emdash/api/media/file/01M1MX4CVV7DK7CFFA64RKGWV5.mp4';
const vtt = '/_emdash/api/media/file/01M1PA7F09101YKXAH9P3RYWKG.vtt';

describe('resolveVideoCaptionTracks', () => {
	it('resolves captions[] with default on', () => {
		const tracks = resolveVideoCaptionTracks(
			{
				provider: 'video',
				url: videoUrl,
				captionsDefaultOn: true,
				captions: [{ url: vtt, srclang: 'en', label: 'English', default: true }],
			},
			videoUrl,
		);
		assert.equal(tracks.length, 1);
		assert.equal(tracks[0].src, vtt);
		assert.equal(tracks[0].isDefault, true);
		assert.equal(tracks[0].srclang, 'en');
	});

	it('resolves legacy captionsUrl', () => {
		const tracks = resolveVideoCaptionTracks(
			{ captionsUrl: vtt, captionsDefaultOn: true },
			videoUrl,
		);
		assert.equal(tracks.length, 1);
		assert.equal(tracks[0].src, vtt);
		assert.equal(tracks[0].isDefault, true);
	});

	it('omits default when captionsDefaultOn is false', () => {
		const tracks = resolveVideoCaptionTracks(
			{
				captionsDefaultOn: false,
				captions: [{ url: vtt, srclang: 'en', label: 'English', default: true }],
			},
			videoUrl,
		);
		assert.equal(tracks.length, 1);
		assert.equal(tracks[0].isDefault, false);
	});

	it('rejects non-emdash caption urls', () => {
		const tracks = resolveVideoCaptionTracks(
			{ captionsUrl: 'https://example.com/x.vtt' },
			videoUrl,
		);
		assert.equal(tracks.length, 0);
	});
});

describe('resolveSelfHostedVideoUrl', () => {
	it('prefers url over id', () => {
		assert.equal(
			resolveSelfHostedVideoUrl({
				provider: 'video',
				url: videoUrl,
				id: '/_emdash/api/media/file/OTHER.mp4',
			}),
			videoUrl,
		);
	});

	it('falls back to id when it is an EmDash media path', () => {
		assert.equal(
			resolveSelfHostedVideoUrl({
				provider: 'video',
				id: videoUrl,
			}),
			videoUrl,
		);
	});

	it('ignores a non-media id', () => {
		assert.equal(
			resolveSelfHostedVideoUrl({
				provider: 'video',
				id: 'youtube-ish-id',
			}),
			null,
		);
	});
});
