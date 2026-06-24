/**
 * Load repo-root `.env.dev` for local operator scripts (Turso, push keys).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const defaultEnvPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".env.dev",
);

function loadEnvFile(envPath, override = false) {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (override || !process.env[k]) {
      process.env[k] = v;
    }
  }
}

export function loadEnvDev(envPath = defaultEnvPath) {
  loadEnvFile(envPath, false);
  const repoRoot = path.dirname(envPath);
  loadEnvFile(path.join(repoRoot, ".env.production"), true);
}

export function pickFirstEnv(names) {
  const binding = pickFirstEnvOptional(names);
  if (binding) return binding;
  throw new Error(`${names.join(" or ")} is required`);
}

export function pickFirstEnvOptional(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

export function tursoUrlHost(url) {
  if (!url) return "(missing)";
  const stripped = url.replace(/^libsql:\/\//, "").replace(/^https:\/\//, "").split("?")[0];
  const at = stripped.lastIndexOf("@");
  return at >= 0 ? stripped.slice(at + 1) : stripped;
}

export function tursoHostSuffixFromLibsqlUrl(url) {
  const host = tursoUrlHost(url);
  const matched = host.match(
    /^freedomtimes-(?:emdash|subscriptions|scheduler)-(?:staging|production)-(.+)$/,
  );
  if (matched) return matched[1];

  const dash = host.indexOf("-");
  if (dash < 0) {
    throw new Error(`Unexpected Turso host in URL (host ${host})`);
  }
  return host.slice(dash + 1);
}

export function deriveLibsqlUrl(databaseName, hostSuffix) {
  const name = databaseName.trim();
  const suffix = hostSuffix.trim();
  if (!name || !suffix) {
    throw new Error("deriveLibsqlUrl requires databaseName and hostSuffix");
  }
  return `libsql://${name}-${suffix}`;
}

const TURSO_HOST_SUFFIX_SOURCE_KEYS = [
  "TURSO_DATABASE_URL",
  "TURSO_SUBSCRIPTIONS_DATABASE_URL",
  "TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL",
  "TURSO_SCHEDULER_DATABASE_URL",
  "TURSO_PRODUCTION_SCHEDULER_DB_URL",
  "TURSO_STAGING_SUBSCRIPTIONS_DB_URL",
  "TURSO_STAGING_SCHEDULER_DB_URL",
];

export function resolveTursoHostSuffixFromEnv() {
  for (const name of TURSO_HOST_SUFFIX_SOURCE_KEYS) {
    const value = process.env[name]?.trim();
    if (!value) continue;
    try {
      const suffix = tursoHostSuffixFromLibsqlUrl(value);
      return { sourceEnvKey: name, suffix };
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Cannot derive Turso host suffix: set one of ${TURSO_HOST_SUFFIX_SOURCE_KEYS.join(", ")} to a libsql:// URL`,
  );
}

export const PRODUCTION_TURSO_DATABASE_NAMES = {
  subscriptions: "freedomtimes-subscriptions-production",
  scheduler: "freedomtimes-scheduler-production",
};

export function productionTerraformDir() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "infra",
    "terraform",
    "environments",
    "production",
  );
}

function resolveTerraformExecutable() {
  const fromPath = process.env.TERRAFORM_PATH?.trim();
  if (fromPath && existsSync(fromPath)) return fromPath;

  const winget = path.join(
    process.env.LOCALAPPDATA || "",
    "Microsoft",
    "WinGet",
    "Links",
    "terraform.exe",
  );
  if (winget && existsSync(winget)) return winget;

  return "terraform";
}

export function tryTerraformOutputRaw(outputName, terraformDir = productionTerraformDir()) {
  try {
    const stdout = execFileSync(
      resolveTerraformExecutable(),
      ["output", "-raw", outputName],
      {
        cwd: terraformDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function enhanceTursoConnectError(error, context) {
  const status = error?.cause?.status;
  if (status !== 404 && status !== 401) return error;

  const host = tursoUrlHost(context.url);
  const hint =
    status === 404
      ? "HTTP 404 usually means Turso has no database at this hostname, or the auth token no longer matches the database (Turso often returns 404 instead of 401 for invalid tokens). Compare URL and token with terraform output in infra/terraform/environments/staging (or production)."
      : "HTTP 401 means the hostname resolved but the auth token was rejected. Refresh the matching TURSO_*_TOKEN in repo-root .env.dev from Terraform outputs or Cloudflare Worker secrets (freedomtimes-scheduler production).";

  const wrapped = new Error(
    `Turso connect/query failed (${context.urlBindingName}, host ${host}): ${error.message}. ${hint}`,
  );
  wrapped.cause = error;
  return wrapped;
}
