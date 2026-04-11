import fs from 'node:fs';
import path from 'node:path';

const serverDir = path.resolve('dist/server');

if (!fs.existsSync(serverDir)) {
  console.warn('[patch-cloudflare-bundle] server directory not found, skipping');
  process.exit(0);
}

function collectMjsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMjsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(fullPath);
    }
  }

  return files;
}

const files = collectMjsFiles(serverDir);

const publishPatchReport = {
  syncDataColumnsGuard: { found: 0, applied: 0 },
  publishErrorDiagnostics: { found: 0, applied: 0 },
};

let patched = 0;
for (const fullPath of files) {
  const name = path.basename(fullPath);
  const original = fs.readFileSync(fullPath, 'utf8');
  let updated = original;

  // EmDash OAuth authorize route is /_emdash/oauth/authorize.
  // Older bundles set CSRF cookie path to /_emdash/api/oauth/authorize,
  // which prevents cookie roundtrip and breaks consent POST with CSRF errors.
  updated = updated.replaceAll(
    'Path=/_emdash/api/oauth/authorize',
    'Path=/_emdash/oauth/authorize'
  );

  updated = updated.replaceAll('createRequire(import.meta.url)', "createRequire('/')");

  // Some EmDash/OAuth responses can arrive with immutable headers in Workers.
  // Ensure baseline security headers are applied to a writable response clone.
  updated = updated.replace(
    'function setBaselineSecurityHeaders(response) {\n  response.headers.set("X-Content-Type-Options", "nosniff");\n  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");\n  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");\n  if (!response.headers.has("Content-Security-Policy")) response.headers.set("X-Frame-Options", "SAMEORIGIN");\n}',
    'function setBaselineSecurityHeaders(response) {\n  let writable = response;\n  try {\n    writable.headers.set("X-Content-Type-Options", "nosniff");\n  } catch {\n    writable = new Response(response.body, response);\n  }\n  writable.headers.set("X-Content-Type-Options", "nosniff");\n  writable.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");\n  writable.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");\n  if (!writable.headers.has("Content-Security-Policy")) writable.headers.set("X-Frame-Options", "SAMEORIGIN");\n  return writable;\n}'
  );

  updated = updated.replace(
    '      const response = await next();\n      setBaselineSecurityHeaders(response);\n      return response;',
    '      const response = await next();\n      return setBaselineSecurityHeaders(response);'
  );

  updated = updated.replace(
    '    const response = await next();\n    setBaselineSecurityHeaders(response);\n    return response;',
    '    const response = await next();\n    return setBaselineSecurityHeaders(response);'
  );

  // Defensive workaround for EmDash publish: tolerate schema drift where
  // draft revision data includes keys for columns removed from ec_* tables.
  // This prevents publish from hard-failing with "no such column".
  const syncGuardNeedle =
    '        if (revision) {\n            await this.syncDataColumns(type, id, revision.data);\n            if (typeof revision.data._slug === "string") {';
  const syncGuardReplacement =
    '        if (revision) {\n            try {\n                await this.syncDataColumns(type, id, revision.data);\n            } catch (err) {\n                const msg = err instanceof Error ? err.message : String(err);\n                const lower = msg.toLowerCase();\n                const isColumnDrift = lower.includes("no such column") || lower.includes("unknown column");\n                if (!isColumnDrift) throw err;\n                console.warn("[patch-cloudflare-bundle] Ignoring publish column drift during syncDataColumns:", msg);\n            }\n            if (typeof revision.data._slug === "string") {';

  if (updated.includes(syncGuardNeedle)) {
    publishPatchReport.syncDataColumnsGuard.found += 1;
    const before = updated;
    updated = updated.replace(syncGuardNeedle, syncGuardReplacement);
    if (updated !== before) {
      publishPatchReport.syncDataColumnsGuard.applied += 1;
    }
  }

  // Improve MCP diagnostics so publish failures include actionable detail.
  const publishErrorNeedle =
    '      return {\n        success: false,\n        error: {\n          code: "CONTENT_PUBLISH_ERROR",\n          message: "Failed to publish content"\n        }\n      };';
  const publishErrorReplacement =
    '      const detail = error instanceof Error ? error.message : String(error);\n      return {\n        success: false,\n        error: {\n          code: "CONTENT_PUBLISH_ERROR",\n          message: `Failed to publish content: ${detail}`\n        }\n      };';

  if (updated.includes(publishErrorNeedle)) {
    publishPatchReport.publishErrorDiagnostics.found += 1;
    const before = updated;
    updated = updated.replace(publishErrorNeedle, publishErrorReplacement);
    if (updated !== before) {
      publishPatchReport.publishErrorDiagnostics.applied += 1;
    }
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
console.log(
  `[patch-cloudflare-bundle] publish syncDataColumns guard: found=${publishPatchReport.syncDataColumnsGuard.found}, applied=${publishPatchReport.syncDataColumnsGuard.applied}`
);
console.log(
  `[patch-cloudflare-bundle] publish error diagnostics: found=${publishPatchReport.publishErrorDiagnostics.found}, applied=${publishPatchReport.publishErrorDiagnostics.applied}`
);
