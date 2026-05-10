/**
 * Rasterizes web/public/favicon.svg into Android mipmap launcher assets.
 * Run after changing the favicon: `npm run android:launcher-icons` (from web/).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const svgPath = path.join(webRoot, 'public', 'favicon.svg');
const resRoot = path.join(webRoot, 'android', 'app', 'src', 'main', 'res');

/** Adaptive icon foreground layer sizes (dp ≈ px per density). */
const densities = [
	{ folder: 'mipmap-mdpi', foregroundPx: 108, legacyPx: 48 },
	{ folder: 'mipmap-hdpi', foregroundPx: 162, legacyPx: 72 },
	{ folder: 'mipmap-xhdpi', foregroundPx: 216, legacyPx: 96 },
	{ folder: 'mipmap-xxhdpi', foregroundPx: 324, legacyPx: 144 },
	{ folder: 'mipmap-xxxhdpi', foregroundPx: 432, legacyPx: 192 },
];

async function main() {
	const input = sharp(svgPath, { density: 300 });
	for (const d of densities) {
		const dir = path.join(resRoot, d.folder);
		await mkdir(dir, { recursive: true });
		const base = input.clone().resize(d.foregroundPx, d.foregroundPx).png();
		await writeFile(path.join(dir, 'ic_launcher_foreground.png'), await base.toBuffer());
		const legacy = input.clone().resize(d.legacyPx, d.legacyPx).png();
		const legacyBuf = await legacy.toBuffer();
		await writeFile(path.join(dir, 'ic_launcher.png'), legacyBuf);
		await writeFile(path.join(dir, 'ic_launcher_round.png'), legacyBuf);
	}
	console.log('[android:launcher-icons] wrote mipmap PNGs from', path.relative(webRoot, svgPath));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
