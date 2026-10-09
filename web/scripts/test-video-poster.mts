import { resolveVideoCaptionTracks } from '../src/lib/content/videoCaptionTracks.ts';
import {
	resolveSelfHostedVideoUrl,
	resolveStoredVideoPlayback,
	resolveVideoBlockSrc,
} from '../src/lib/content/videoPlayback.ts';
import {
	resolveSelfHostedVideoFrame,
	resolveVideoPoster,
	selfHostedVideoPreload,
	type ResolvedVideoPoster,
} from '../src/lib/content/videoPoster.ts';
import {
	legacyVideoToPortableNode,
	parseLegacyTextContent,
} from '../src/lib/content/contentBlocks.ts';
import { applyTransforms, resolveTransforms } from './lib/pt-migrate/transforms/index.mjs';
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

describe('EmDash 1.2.0 video block', () => {
	const block = {
		_type: 'video',
		_key: 'clip',
		asset: {
			_ref: '01M1MX4CVV7DK7CFFA64RKGWV5',
			url: videoUrl,
		},
		width: 1920,
		height: 1080,
		poster: posterPath,
		captions: [{ url: vtt, srclang: 'en', label: 'English', default: true }],
	};

	it('plays asset.url and ignores the media id', () => {
		assert.equal(resolveVideoBlockSrc(block), videoUrl);
		const playback = resolveStoredVideoPlayback(block);
		assert.equal(playback.kind, 'player');
		if (playback.kind !== 'player') return;
		assert.equal(playback.src, videoUrl);
		const remote = resolveStoredVideoPlayback({
			_type: 'video',
			_key: 'remote',
			asset: {
				_ref: 'remote',
				url: 'https://archive.org/download/example/film.mp4',
				provider: 'local',
			},
		});
		assert.equal(remote.kind, 'player');
		if (remote.kind !== 'player') return;
		assert.equal(remote.src, 'https://archive.org/download/example/film.mp4');
		assert.equal(
			resolveVideoBlockSrc({
				_type: 'video',
				asset: { _ref: '01M1MX4CVV7DK7CFFA64RKGWV5' },
			}),
			null,
		);
		assert.deepEqual(
			resolveStoredVideoPlayback({
				_type: 'video',
				asset: { _ref: '01M1MX4CVV7DK7CFFA64RKGWV5' },
			}),
			{ kind: 'none' },
		);
		assert.equal(
			resolveVideoBlockSrc({
				_type: 'video',
				asset: { _ref: 'clip', url: 'javascript:alert(1)' },
			}),
			null,
		);
	});

	it('does not treat a cloudflare-stream https URL as a local mp4', () => {
		const streamUrl = 'https://customer.example/stream.m3u8';
		const node = {
			_type: 'video',
			_key: 'stream',
			asset: {
				_ref: 'stream-id',
				url: streamUrl,
				provider: 'cloudflare-stream',
			},
			caption: 'Hall',
			width: 1920,
			height: 1080,
			poster: posterPath,
			captions: [{ url: vtt, srclang: 'en', label: 'English', default: true }],
		};
		assert.equal(resolveVideoBlockSrc(node), null);
		assert.deepEqual(resolveStoredVideoPlayback(node), {
			kind: 'core',
			node: {
				_type: 'video',
				_key: 'stream',
				asset: {
					_ref: 'stream-id',
					url: streamUrl,
					provider: 'cloudflare-stream',
				},
				caption: 'Hall',
				width: 1920,
				height: 1080,
			},
		});
		const fractional = resolveStoredVideoPlayback({
			...node,
			width: 1.5,
			height: 0,
		});
		assert.equal(fractional.kind, 'core');
		if (fractional.kind !== 'core') return;
		assert.equal(fractional.node.width, undefined);
		assert.equal(fractional.node.height, undefined);
		assert.equal('poster' in fractional.node, false);
		assert.equal('captions' in fractional.node, false);
	});

	it('does not delegate http or javascript video-block URLs', () => {
		for (const url of ['http://archive.org/download/example/film.mp4', 'javascript:alert(1)']) {
			const node = {
				_type: 'video',
				_key: 'bad',
				asset: { _ref: 'clip', url },
				poster: posterPath,
				captions: [{ url: vtt, srclang: 'en', label: 'English', default: true }],
			};
			assert.equal(resolveVideoBlockSrc(node), null);
			assert.deepEqual(resolveStoredVideoPlayback(node), { kind: 'none' });
		}
	});

	it('reserves the block width and height when a poster is also set', () => {
		const poster = resolveVideoPoster(block);
		assert.equal(poster?.src, posterPath);
		assert.deepEqual(resolveSelfHostedVideoFrame(block, poster), {
			width: 1920,
			height: 1080,
			aspectRatio: '1920 / 1080',
		});
		assert.equal(selfHostedVideoPreload(poster), 'none');
		const tracks = resolveVideoCaptionTracks(block, videoUrl);
		assert.equal(tracks.length, 1);
		assert.equal(tracks[0].src, vtt);
		assert.equal(tracks[0].isDefault, true);
	});

	it('uses 16:9 for a poster when the block has no dimensions', () => {
		const node = { _type: 'video', asset: { url: videoUrl }, poster: httpsPoster };
		const poster = resolveVideoPoster(node);
		assert.deepEqual(resolveSelfHostedVideoFrame(node, poster), {
			width: 16,
			height: 9,
			aspectRatio: '16 / 9',
		});
	});

	it('keeps caption tracks and the block frame when poster is absent', () => {
		const { poster: _poster, ...node } = block;
		const poster = resolveVideoPoster(node);
		assert.equal(poster, null);
		assert.equal(selfHostedVideoPreload(poster), 'metadata');
		const playback = resolveStoredVideoPlayback(node);
		assert.equal(playback.kind, 'player');
		if (playback.kind !== 'player') return;
		assert.equal(playback.src, videoUrl);
		assert.equal(playback.poster, null);
		assert.equal(playback.preload, 'metadata');
		assert.equal(playback.tracks.length, 1);
		assert.equal(playback.tracks[0].src, vtt);
		assert.equal(playback.tracks[0].isDefault, true);
		assert.deepEqual(playback.frame, {
			width: 1920,
			height: 1080,
			aspectRatio: '1920 / 1080',
		});
		const tracks = resolveVideoCaptionTracks(node, videoUrl);
		assert.equal(tracks.length, 1);
		assert.equal(tracks[0].src, vtt);
		assert.equal(tracks[0].srclang, 'en');
		assert.equal(tracks[0].label, 'English');
		assert.equal(tracks[0].isDefault, true);
	});

	it('leaves the frame to file metadata when poster and dimensions are absent', () => {
		const node = {
			_type: 'video',
			_key: 'clip',
			asset: block.asset,
			captions: block.captions,
		};
		const playback = resolveStoredVideoPlayback(node);
		assert.equal(playback.kind, 'player');
		if (playback.kind !== 'player') return;
		assert.equal(playback.poster, null);
		assert.equal(playback.frame, null);
		assert.equal(playback.preload, 'metadata');
		assert.equal(playback.src, videoUrl);
	});

	it('does not let a fractional block dimension replace the poster box', () => {
		const node = {
			_type: 'video',
			asset: { url: videoUrl },
			width: 1920.5,
			height: 1080,
			poster: posterPath,
		};
		const poster = resolveVideoPoster(node);
		assert.deepEqual(resolveSelfHostedVideoFrame(node, poster), {
			width: 16,
			height: 9,
			aspectRatio: '16 / 9',
		});
	});
});

describe('one player for both stored shapes', () => {
	const shared = {
		caption: 'Hall',
		width: 1920,
		height: 1080,
		poster: posterPath,
		captions: [{ url: vtt, srclang: 'en', label: 'English', default: true }],
	};

	it('plays a stored embed and a local video block through the same playback value', () => {
		const fromBlock = resolveStoredVideoPlayback({
			_type: 'video',
			_key: 'clip',
			asset: { _ref: '01M1MX4CVV7DK7CFFA64RKGWV5', url: videoUrl },
			...shared,
		});
		const fromEmbed = resolveStoredVideoPlayback({
			_type: 'embed',
			provider: 'video',
			url: videoUrl,
			...shared,
		});
		assert.deepEqual(fromBlock, fromEmbed);
		assert.equal(fromBlock.kind, 'player');
		if (fromBlock.kind !== 'player') return;
		assert.equal(fromBlock.src, videoUrl);
		assert.equal(fromBlock.caption, 'Hall');
		assert.equal(fromBlock.poster?.src, posterPath);
		assert.deepEqual(fromBlock.frame, {
			width: 1920,
			height: 1080,
			aspectRatio: '1920 / 1080',
		});
		assert.equal(fromBlock.preload, 'none');
		assert.equal(fromBlock.tracks.length, 1);
		assert.equal(fromBlock.tracks[0].src, vtt);
		assert.equal(fromBlock.tracks[0].isDefault, true);
	});

	it('plays a stored embed that has no poster', () => {
		const playback = resolveStoredVideoPlayback({
			_type: 'embed',
			provider: 'video',
			url: videoUrl,
			captionsUrl: vtt,
			captionsDefaultOn: true,
		});
		assert.equal(playback.kind, 'player');
		if (playback.kind !== 'player') return;
		assert.equal(playback.src, videoUrl);
		assert.equal(playback.poster, null);
		assert.equal(playback.frame, null);
		assert.equal(playback.preload, 'metadata');
		assert.equal(playback.tracks.length, 1);
		assert.equal(playback.tracks[0].src, vtt);
		assert.equal(playback.tracks[0].isDefault, true);
	});

	it('plays a stored embed whose mp4 is only on id', () => {
		const playback = resolveStoredVideoPlayback({
			_type: 'embed',
			provider: 'video',
			id: videoUrl,
		});
		assert.equal(playback.kind, 'player');
		if (playback.kind !== 'player') return;
		assert.equal(playback.src, videoUrl);
		assert.equal(playback.poster, null);
		assert.equal(playback.preload, 'metadata');
	});

	it('does not play a refused embed url', () => {
		assert.deepEqual(
			resolveStoredVideoPlayback({
				_type: 'embed',
				provider: 'video',
				url: 'javascript:alert(1)',
			}),
			{ kind: 'none' },
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

	it('writes a self-hosted legacy video as a 1.2.0 video block', () => {
		const node = legacyVideoToPortableNode({
			_type: 'video',
			url: 'https://archive.org/download/example/film.mp4',
			poster: { url: httpsPoster },
			alt: 'Hall',
			width: 1920,
			height: 1080,
			captionsUrl: vtt,
			captionsDefaultOn: true,
		});
		assert.deepEqual(node, {
			_type: 'video',
			asset: { url: 'https://archive.org/download/example/film.mp4' },
			caption: 'Hall',
			width: 1920,
			height: 1080,
			poster: { url: httpsPoster },
			captionsUrl: vtt,
			captionsDefaultOn: true,
		});
	});

	it('puts a bare media id on asset._ref and ignores a path id', () => {
		const withId = legacyVideoToPortableNode({
			_type: 'video',
			url: videoUrl,
			id: '01M1MX4CVV7DK7CFFA64RKGWV5',
		});
		assert.deepEqual(withId?.asset, {
			_ref: '01M1MX4CVV7DK7CFFA64RKGWV5',
			url: videoUrl,
		});
		const pathId = legacyVideoToPortableNode({
			_type: 'video',
			url: videoUrl,
			id: videoUrl,
		});
		assert.deepEqual(pathId?.asset, { url: videoUrl });
	});

	it('drops a non-integer dimension', () => {
		const node = legacyVideoToPortableNode({
			_type: 'video',
			url: videoUrl,
			width: 1.5,
			height: 1080,
		});
		assert.equal(node?.width, undefined);
		assert.equal(node?.height, 1080);
	});

	it('leaves youtube as a youtube node', () => {
		const node = legacyVideoToPortableNode({
			_type: 'video',
			url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
			alt: 'Clip',
			poster: posterPath,
		});
		assert.equal(node?._type, 'youtube');
		assert.equal(node?.title, 'Clip');
		assert.equal(node?.poster, undefined);
	});
});

describe('video transform leaves editor blocks', () => {
	const transforms = resolveTransforms(['video']);

	it('leaves an editor video block unchanged', () => {
		const editor = {
			_type: 'video',
			_key: 'clip',
			asset: { _ref: '01M1MX4CVV7DK7CFFA64RKGWV5', url: videoUrl },
			width: 1920,
			height: 1080,
			caption: 'Hall',
			poster: posterPath,
			captions: [{ url: vtt, srclang: 'en', label: 'English', default: true }],
		};
		const { content, changes } = applyTransforms([editor], transforms);
		assert.equal(changes.length, 0);
		assert.deepEqual(content[0], editor);
	});

	it('leaves an editor block whose asset url is a youtube watch url', () => {
		const editor = {
			_type: 'video',
			asset: {
				_ref: 'yt',
				url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
				provider: 'youtube',
			},
			width: 1920,
			height: 1080,
		};
		const { content, changes } = applyTransforms([editor], transforms);
		assert.equal(changes.length, 0);
		assert.deepEqual(content[0], editor);
	});

	it('still converts a legacy video that has a top-level url', () => {
		const { content, changes } = applyTransforms(
			[{ _type: 'video', url: videoUrl, alt: 'Hall' }],
			transforms,
		);
		assert.equal(changes.length, 1);
		const block = content[0] as Record<string, unknown>;
		assert.equal(block._type, 'embed');
		assert.equal(block.provider, 'video');
		assert.equal(block.url, videoUrl);
		assert.equal(block.caption, 'Hall');
	});

	it('still converts a legacy youtube video block', () => {
		const { content, changes } = applyTransforms(
			[{ _type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', alt: 'Clip' }],
			transforms,
		);
		assert.equal(changes.length, 1);
		const block = content[0] as Record<string, unknown>;
		assert.equal(block._type, 'youtube');
		assert.equal(block.id, 'dQw4w9WgXcQ');
	});

	it('still rewrites a video block that has both asset.url and a legacy url', () => {
		const { content, changes } = applyTransforms(
			[{ _type: 'video', url: videoUrl, asset: { _ref: 'clip', url: videoUrl } }],
			transforms,
		);
		assert.equal(changes.length, 1);
		assert.equal((content[0] as Record<string, unknown>)._type, 'embed');
	});
});
