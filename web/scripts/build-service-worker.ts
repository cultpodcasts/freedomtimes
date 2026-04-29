import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const entryPoint = fileURLToPath(new URL('../src/service-worker.ts', import.meta.url));
const outputFile = fileURLToPath(new URL('../public/service-worker.js', import.meta.url));

await build({
  absWorkingDir: rootDir,
  bundle: true,
  entryPoints: [entryPoint],
  format: 'iife',
  minify: false,
  outfile: outputFile,
  platform: 'browser',
  sourcemap: false,
  target: 'es2022',
});