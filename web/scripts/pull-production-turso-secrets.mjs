import { getPlatformProxy } from "wrangler";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webDir, "..");
const envDev = path.join(repoRoot, ".env.dev");

function setKey(key, val) {
  const lines = readFileSync(envDev, "utf8").split(/\r?\n/);
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pat = new RegExp(`^${esc}=`);
  let updated = false;
  const out = lines.map((line) => {
    if (pat.test(line)) {
      updated = true;
      return `${key}=${val}`;
    }
    return line;
  });
  if (!updated) out.push(`${key}=${val}`);
  writeFileSync(envDev, `${out.join("\n")}\n`, "utf8");
}

const configPath = path.join(webDir, "wrangler.jsonc");
const timeoutMs = 120_000;
const run = (async () => {
  const { env, dispose } = await getPlatformProxy({
    configPath,
    environment: "production",
    remoteBindings: true,
  });
  try {
    return {
      subTok: env.TURSO_SUBSCRIPTIONS_AUTH_TOKEN ?? "",
      subUrl: env.TURSO_SUBSCRIPTIONS_DATABASE_URL ?? "",
      schedTok: env.TURSO_SCHEDULER_AUTH_TOKEN ?? "",
      schedUrl: env.TURSO_SCHEDULER_DATABASE_URL ?? "",
    };
  } finally {
    await dispose();
  }
})();

const result = await Promise.race([
  run,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
]);

for (const [k, v] of Object.entries(result)) {
  console.log(k, "len", String(v).length);
}

if (!result.subTok) {
  throw new Error("TURSO_SUBSCRIPTIONS_AUTH_TOKEN empty from remote bindings");
}

setKey("TURSO_SUBSCRIPTIONS_AUTH_TOKEN", result.subTok);
setKey("TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN", result.subTok);
if (result.subUrl) {
  setKey("TURSO_SUBSCRIPTIONS_DATABASE_URL", result.subUrl);
  setKey("TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL", result.subUrl);
}
if (result.schedTok) {
  setKey("TURSO_SCHEDULER_AUTH_TOKEN", result.schedTok);
  setKey("TURSO_PRODUCTION_SCHEDULER_DB_TOKEN", result.schedTok);
}
if (result.schedUrl) {
  setKey("TURSO_SCHEDULER_DATABASE_URL", result.schedUrl);
  setKey("TURSO_PRODUCTION_SCHEDULER_DB_URL", result.schedUrl);
}
console.log("Updated .env.dev from Cloudflare remote bindings");

