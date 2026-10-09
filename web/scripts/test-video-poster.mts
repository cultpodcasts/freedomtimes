import {
	resolveSelfHostedVideoUrl,
	resolveVideoCaptionTracks,
} from '../src/lib/content/videoCaptionTracks.ts';
import {
	resolveVideoPoster,
	selfHostedVideoPreload,
	type ResolvedVideoPoster,
} from '../src/lib/content/videoPoster.ts';
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

function posterResult(src: string, width = 16, height = 9): ResolvedVideoPoster {
	return { src, width, height, aspectRatio: `${width} / ${height}` };
}

describe('resolveVideoPoster', () => {
	it('accepts an EmDash media-file image path', () => {
		assert.deepEqual(resolveVideoPoster({ poster: posterPath }), posterResult(posterPath));
	});

	it('accepts a media-file image URL and keeps the site path', () => {
		assert.deepEqual(
			resolveVideoPoster({
				poster: `https://staging.example/_emdash/api/media/file/01M2DW4H4PB5X0AEC83M40GN7R.jpg?x=1`,
			}),
			posterResult(posterPath),
		);
	});

	it('accepts a storage key and image asset references', () => {
		assert.deepEqual(
			resolveVideoPoster({ poster: '01M2DW4H4PB5X0AEC83M40GN7R.jpg' }),
			posterResult(posterPath),
		);
		assert.deepEqual(
			resolveVideoPoster({ poster: { _ref: '01M2DW4H4PB5X0AEC83M40GN7R.webp' } }),
			posterResult('/_emdash/api/media/file/01M2DW4H4PB5X0AEC83M40GN7R.webp'),
		);
		assert.deepEqual(
			resolveVideoPoster({
				poster: { asset: { url: posterPath } },
			}),
			posterResult(posterPath),
		);
		assert.deepEqual(
			resolveVideoPoster({
				poster: { meta: { storageKey: '01M2DW4H4PB5X0AEC83M40GN7R.png' } },
			}),
			posterResult('/_emdash/api/media/file/01M2DW4H4PB5X0AEC83M40GN7R.png'),
		);
	});

	it('accepts a poster id that already has an image extension', () => {
		assert.deepEqual(
			resolveVideoPoster({ poster: { id: '01M2DW4H4PB5X0AEC83M40GN7R.jpg' } }),
			posterResult(posterPath),
		);
	});

	it('passes width and height from the poster media object', () => {
		assert.deepEqual(
			resolveVideoPoster({
				poster: { url: posterPath, width: 1920, height: 1080 },
			}),
			posterResult(posterPath, 1920, 1080),
		);
		assert.deepEqual(
			resolveVideoPoster({
				poster: { url: httpsPoster, displayWidth: 1280, displayHeight: 720 },
			}),
			posterResult(httpsPoster, 1280, 720),
		);
		assert.deepEqual(
			resolveVideoPoster({ poster: { url: posterPath, width: 1920 } }),
			posterResult(posterPath),
		);
		assert.deepEqual(
			resolveVideoPoster({
				poster: { asset: { url: posterPath, width: 640, height: 360 } },
			}),
			posterResult(posterPath, 640, 360),
		);
	});

	it('accepts an https URL and reserves 16:9 when it has no dimensions', () => {
		assert.deepEqual(
			resolveVideoPoster({ poster: httpsPoster }),
			posterResult(httpsPoster),
		);
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
		assert.deepEqual(poster, posterResult(posterPath));
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

	it('drops the sanitizeHref sentinel, mailto, http, and non-media paths', () => {
		assert.equal(resolveSelfHostedVideoUrl({ url: 'javascript:alert(1)' }), null);
		assert.equal(resolveSelfHostedVideoUrl({ url: 'mailto:editor@example.com' }), null);
		assert.equal(resolveSelfHostedVideoUrl({ url: '/homepage' }), null);
		assert.equal(
			resolveSelfHostedVideoUrl({
				url: 'http://archive.org/download/example/film.mp4',
			}),
			null,
		);
		assert.equal(resolveSelfHostedVideoUrl({ url: vtt }), null);
		assert.equal(resolveSelfHostedVideoUrl({ id: 'javascript:alert(1)' }), null);
		assert.equal(resolveSelfHostedVideoUrl({ id: vtt }), null);
		assert.equal(resolveSelfHostedVideoUrl({ id: '/homepage' }), null);
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
