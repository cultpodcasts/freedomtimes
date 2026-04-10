import fs from 'node:fs';
import path from 'node:path';

const chunksDir = path.resolve('dist/server/chunks');

if (!fs.existsSync(chunksDir)) {
  console.warn('[patch-cloudflare-bundle] chunks directory not found, skipping');
  process.exit(0);
}

const files = fs.readdirSync(chunksDir).filter((name) => name.endsWith('.mjs'));

let patched = 0;
for (const name of files) {
  const fullPath = path.join(chunksDir, name);
  const original = fs.readFileSync(fullPath, 'utf8');
  let updated = original;

  if (name.startsWith('adapt-sandbox-entry_')) {
    updated = updated.replaceAll('createRequire(import.meta.url)', "createRequire('/')");
  }

  if (name.startsWith('worker-entry_')) {
    updated = updated
      .replace(
        "  if (app.manifest.assets.has(requestPathname)) {\n    return env.ASSETS.fetch(request.url.replace(/\\.html$/, \"\"));\n  }",
        "  const assetsBinding = env.ASSETS;\n  if (assetsBinding && app.manifest.assets.has(requestPathname)) {\n    return assetsBinding.fetch(request.url.replace(/\\.html$/, \"\"));\n  }"
      )
      .replace(
        "  if (!routeData) {\n    const asset = await env.ASSETS.fetch(\n      request.url.replace(/index.html$/, \"\").replace(/\\.html$/, \"\")\n    );\n    if (asset.status !== 404) {\n      return asset;\n    }\n  }",
        "  if (!routeData && assetsBinding) {\n    const asset = await assetsBinding.fetch(\n      request.url.replace(/index.html$/, \"\").replace(/\\.html$/, \"\")\n    );\n    if (asset.status !== 404) {\n      return asset;\n    }\n  }"
      )
      .replace(
        "    prerenderedErrorPageFetch: async (url) => {\n      return env.ASSETS.fetch(url.replace(/\\.html$/, \"\"));\n    },",
        "    prerenderedErrorPageFetch: async (url) => {\n      if (!assetsBinding) return new Response(null, { status: 404 });\n      return assetsBinding.fetch(url.replace(/\\.html$/, \"\"));\n    },"
      );
  }

  if (updated !== original) {
    fs.writeFileSync(fullPath, updated, 'utf8');
    patched += 1;
  }
}

console.log(`[patch-cloudflare-bundle] patched ${patched} file(s)`);
