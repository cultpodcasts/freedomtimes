import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const viewSource = readFileSync(
	fileURLToPath(new URL('../src/components/EmDashContentView.astro', import.meta.url)),
	'utf8',
);

/** Declaration bodies of every `lite-youtube` rule in EmDashContentView. */
function liteYoutubeDeclarationBodies(source: string): string[] {
	const bodies = [...source.matchAll(/lite-youtube\)\s*\{([^}]+)\}/g)].map((match) =>
		match[1].trim(),
	);
	assert.ok(bodies.length >= 1, 'expected at least one lite-youtube rule');
	return bodies;
}

describe('lite-youtube poster styles', () => {
	const bodies = liteYoutubeDeclarationBodies(viewSource);
	const combined = bodies.join('\n');

	it('does not use the background shorthand that resets poster size/repeat', () => {
		for (const body of bodies) {
			assert.doesNotMatch(
				body,
				/(?<![\w-])background\s*:/,
				'lite-youtube rules must use background-color (and size/repeat/position), not background:',
			);
		}
	});

	it('covers the poster without tiling and keeps a black letterbox fill', () => {
		assert.match(combined, /background-size:\s*cover\b/);
		assert.match(combined, /background-repeat:\s*no-repeat\b/);
		assert.match(combined, /background-position:\s*center\b/);
		assert.match(combined, /background-color:\s*#000000\b/);
	});

	it('does not restyle the play-button hit area', () => {
		assert.doesNotMatch(viewSource, /\.lyt-playbtn\s*\{/);
		assert.doesNotMatch(viewSource, /\.lty-playbtn\s*\{/);
	});
});
