import {
	resolveSelfHostedVideoUrl,
	resolveVideoCaptionTracks,
	resolveVideoPoster,
	selfHostedVideoPreload,
} from '../src/lib/content/videoCaptionTracks.ts';
import {
	legacyVideoToPortableNode,
	parseLegacyTextContent,
} from '../src/lib/content/contentBlocks.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const videoUrl = '/_emdash/api/media/file/01M1MX4CVV7DK7CFFA64RKGWV5.mp4';
const posterPath = '/_emdash/api/media/file/01M2DW4H4PB5X0AEC83M40GN7R.jpg';
const vtt = '/_emdash/api/media/file/01M1PA7F09101YKXAH9P3RYWKG.vtt';
const httpsPoster = 'https://archive.org/download/example/poster.jpg';

describe('resolveVideoPoster', () => {
	it('accepts an EmDash media-file image path', () => {
		assert.equal(resolveVideoPoster({ poster: posterPath }), posterPath);
	});

	it('accepts a media-file image URL and keeps the site path', () => {
		assert.equal(
			resolveVideoPoster({
				poster: `https://staging.example/_emdash/api/media/file/01M2DW4H4PB5X0AEC83M40GN7R.jpg?x=1`,
			}),
			posterPath,
		);
	});

	it('accepts a storage key and image asset references', () => {
		assert.equal(
			resolveVideoPoster({ poster: '01M2DW4H4PB5X0AEC83M40GN7R.jpg' }),
			posterPath,
		);
		assert.equal(
			resolveVideoPoster({ poster: { _ref: '01M2DW4H4PB5X0AEC83M40GN7R.webp' } }),
			'/_emdash/api/media/file/01M2DW4H4PB5X0AEC83M40GN7R.webp',
		);
		assert.equal(
			resolveVideoPoster({
				poster: { asset: { url: posterPath } },
			}),
			posterPath,
		);
		assert.equal(
			resolveVideoPoster({
				poster: { meta: { storageKey: '01M2DW4H4PB5X0AEC83M40GN7R.png' } },
			}),
			'/_emdash/api/media/file/01M2DW4H4PB5X0AEC83M40GN7R.png',
		);
	});

	it('accepts an https URL', () => {
		assert.equal(resolveVideoPoster({ poster: httpsPoster }), httpsPoster);
	});

	it('ignores http, unsafe schemes, non-image media, and empty values', () => {
		assert.equal(resolveVideoPoster({ poster: 'http://example.com/poster.jpg' }), null);
		assert.equal(resolveVideoPoster({ poster: 'javascript:alert(1)' }), null);
		assert.equal(
			resolveVideoPoster({ poster: { url: 'javascript:alert(1)' } }),
			null,
		);
		assert.equal(resolveVideoPoster({ poster: videoUrl }), null);
		assert.equal(resolveVideoPoster({ poster: '/homepage' }), null);
		assert.equal(resolveVideoPoster({ poster: '   ' }), null);
		assert.equal(resolveVideoPoster({}), null);
	});

	it('does not change caption resolution or preload when poster is absent', () => {
		const node = {
			provider: 'video',
			url: videoUrl,
			captionsUrl: vtt,
			captionsDefaultOn: true,
		};
		assert.equal(resolveVideoPoster(node), null);
		assert.equal(selfHostedVideoPreload(null), 'metadata');
		const tracks = resolveVideoCaptionTracks(node, videoUrl);
		assert.equal(tracks.length, 1);
		assert.equal(tracks[0].src, vtt);
		assert.equal(tracks[0].isDefault, true);
	});

	it('uses preload none only when a poster resolves, and keeps tracks', () => {
		const node = {
			provider: 'video',
			url: videoUrl,
			poster: posterPath,
			captions: [{ url: vtt, srclang: 'en', label: 'English', default: true }],
		};
		const poster = resolveVideoPoster(node);
		assert.equal(poster, posterPath);
		assert.equal(selfHostedVideoPreload(poster), 'none');
		const tracks = resolveVideoCaptionTracks(node, videoUrl);
		assert.equal(tracks.length, 1);
		assert.equal(tracks[0].src, vtt);
		assert.equal(tracks[0].isDefault, true);
	});
});

describe('resolveSelfHostedVideoUrl sanitise', () => {
	it('leaves a safe media path and https URL unchanged', () => {
		assert.equal(resolveSelfHostedVideoUrl({ url: videoUrl }), videoUrl);
		assert.equal(
			resolveSelfHostedVideoUrl({
				url: 'https://archive.org/download/example/film.mp4',
			}),
			'https://archive.org/download/example/film.mp4',
		);
	});

	it('replaces an unsafe video URL the way EmDash sanitizeHref does', () => {
		assert.equal(
			resolveSelfHostedVideoUrl({ url: 'javascript:alert(1)' }),
			'#',
		);
	});
});

describe('markdown video blocks keep poster', () => {
	it('passes poster through an embed ec:block', () => {
		const blocks = parseLegacyTextContent(
			`<!--ec:block ${JSON.stringify({
				_type: 'embed',
				provider: 'video',
				url: videoUrl,
				poster: posterPath,
				captionsUrl: vtt,
			})} -->`,
		);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].type, 'portable');
		const node = (blocks[0] as { type: 'portable'; value: Record<string, unknown>[] })
			.value[0];
		assert.equal(node.poster, posterPath);
		assert.equal(node.captionsUrl, vtt);
		assert.equal(node.url, videoUrl);
	});

	it('copies poster from a legacy video ec:block onto the embed node', () => {
		const node = legacyVideoToPortableNode({
			_type: 'video',
			url: 'https://archive.org/download/example/film.mp4',
			poster: { url: httpsPoster },
			alt: 'Hall',
		});
		assert.ok(node);
		assert.equal(node._type, 'embed');
		assert.equal(node.provider, 'video');
		assert.deepEqual(node.poster, { url: httpsPoster });
		assert.equal(node.caption, 'Hall');
	});
});
