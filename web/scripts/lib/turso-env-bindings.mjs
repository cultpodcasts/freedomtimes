/**
 * Canonical Turso .env.dev key names for operator scripts.
 *
 * Source of truth (do not guess key names - update here when sync scripts change):
 *   scripts/sync-staging-turso-env-dev.ps1
 *   scripts/sync-production-turso-env-dev.ps1
 */
import { fileURLToPath } from "node:url";
import {
  PRODUCTION_TURSO_DATABASE_NAMES,
  deriveLibsqlUrl,
  pickFirstEnv,
  pickFirstEnvOptional,
  resolveTursoHostSuffixFromEnv,
  tryTerraformOutputRaw,
} from "./load-env-dev.mjs";

/** @typedef {{ urlKeys: string[], tokenKeys: string[], syncScript: string, terraformUrlOutput: string, terraformNameOutput: string, terraformTokenOutput: string }} TursoDbBinding */

/** @type {{ subscriptions: TursoDbBinding, scheduler: TursoDbBinding }} */
export const STAGING_TURSO_BINDINGS = {
  subscriptions: {
    urlKeys: ["TURSO_STAGING_SUBSCRIPTIONS_DB_URL"],
    tokenKeys: ["TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN"],
    syncScript: "scripts/sync-staging-turso-env-dev.ps1",
    terraformUrlOutput: "subscriptions_turso_database_url",
    terraformNameOutput: "subscriptions_turso_database_name",
    terraformTokenOutput: "subscriptions_turso_database_auth_token",
  },
  scheduler: {
    urlKeys: ["TURSO_STAGING_SCHEDULER_DB_URL"],
    tokenKeys: ["TURSO_STAGING_SCHEDULER_DB_TOKEN"],
    syncScript: "scripts/sync-staging-turso-env-dev.ps1",
    terraformUrlOutput: "scheduler_turso_database_url",
    terraformNameOutput: "scheduler_turso_database_name",
    terraformTokenOutput: "scheduler_turso_database_auth_token",
  },
};

/**
 * Production sync writes each Terraform value to two .env.dev keys (aliases).
 * Scripts pick the first key that is set; order matches sync-production-turso-env-dev.ps1.
 */
/** @type {{ subscriptions: TursoDbBinding, scheduler: TursoDbBinding }} */
export const PRODUCTION_TURSO_BINDINGS = {
  subscriptions: {
    urlKeys: [
      "TURSO_SUBSCRIPTIONS_DATABASE_URL",
      "TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL",
    ],
    tokenKeys: [
      "TURSO_SUBSCRIPTIONS_AUTH_TOKEN",
      "TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN",
    ],
    syncScript: "scripts/sync-production-turso-env-dev.ps1",
    terraformUrlOutput: "subscriptions_turso_database_url",
    terraformNameOutput: "subscriptions_turso_database_name",
    terraformTokenOutput: "subscriptions_turso_database_auth_token",
  },
  scheduler: {
    urlKeys: [
      "TURSO_SCHEDULER_DATABASE_URL",
      "TURSO_PRODUCTION_SCHEDULER_DB_URL",
    ],
    tokenKeys: [
      "TURSO_SCHEDULER_AUTH_TOKEN",
      "TURSO_PRODUCTION_SCHEDULER_DB_TOKEN",
    ],
    syncScript: "scripts/sync-production-turso-env-dev.ps1",
    terraformUrlOutput: "scheduler_turso_database_url",
    terraformNameOutput: "scheduler_turso_database_name",
    terraformTokenOutput: "scheduler_turso_database_auth_token",
  },
};

const TARGET_BINDINGS = {
  staging: STAGING_TURSO_BINDINGS,
  production: PRODUCTION_TURSO_BINDINGS,
};

function resolveBindingKeys(target) {
  const normalized = String(target).trim().toLowerCase();
  const bindings = TARGET_BINDINGS[normalized];
  if (!bindings) {
    throw new Error(`target must be staging or production (got ${JSON.stringify(target)})`);
  }
  return { normalized, bindings };
}

/**
 * @param {"subscriptions"|"scheduler"} dbKind
 * @param {"staging"|"production"} target
 * @param {TursoDbBinding} config
 */
function resolveUrlBinding(target, dbKind, config) {
  const direct = pickFirstEnvOptional(config.urlKeys);
  if (direct) return direct;

  if (target !== "production") {
    throw new Error(`${config.urlKeys.join(" or ")} is required`);
  }

  const terraformUrl = tryTerraformOutputRaw(config.terraformUrlOutput);
  if (terraformUrl) {
    return { name: `terraform output ${config.terraformUrlOutput}`, value: terraformUrl };
  }

  const suffixInfo = resolveTursoHostSuffixFromEnv();
  const terraformName =
    tryTerraformOutputRaw(config.terraformNameOutput) || PRODUCTION_TURSO_DATABASE_NAMES[dbKind];
  const derived = deriveLibsqlUrl(terraformName, suffixInfo.suffix);
  const primaryKey = config.urlKeys[0];
  return {
    name: `${primaryKey} (derived from ${suffixInfo.sourceEnvKey} + ${terraformName})`,
    value: derived,
  };
}

/**
 * @param {"staging"|"production"} target
 * @param {TursoDbBinding} config
 */
function resolveTokenBinding(target, config) {
  const direct = pickFirstEnvOptional(config.tokenKeys);
  if (direct) return direct;

  if (target === "production") {
    const terraformToken = tryTerraformOutputRaw(config.terraformTokenOutput);
    if (terraformToken) {
      return {
        name: `terraform output ${config.terraformTokenOutput}`,
        value: terraformToken,
      };
    }

    const emdashUrl = process.env.TURSO_DATABASE_URL?.trim() || "";
    if (/freedomtimes-emdash-production-/i.test(emdashUrl)) {
      const paired = pickFirstEnvOptional(["TURSO_AUTH_TOKEN"]);
      if (paired) {
        return {
          name: "TURSO_AUTH_TOKEN (paired with production TURSO_DATABASE_URL)",
          value: paired.value,
        };
      }
    }
  }

    const authToken = pickFirstEnvOptional(["TURSO_AUTH_TOKEN"]);
    if (authToken) {
      return {
        name: "TURSO_AUTH_TOKEN (fallback; must match the subscriptions database)",
        value: authToken.value,
      };
    }
  const tried = [...config.tokenKeys];
  if (target === "production") {
    tried.push(`terraform output ${config.terraformTokenOutput}`);
  }

  throw new Error(
    `${tried.join(" or ")} is required for ${target}. ` +
      `Present Turso-related keys in .env.dev: ${listPresentTursoKeys().join(", ") || "(none)"}. ` +
      `Run: pwsh ${config.syncScript}`,
  );
}

function listPresentTursoKeys() {
  return Object.keys(process.env)
    .filter((key) => /^(TURSO_|TF_VAR_TURSO)/.test(key))
    .filter((key) => process.env[key]?.trim())
    .sort();
}

/**
 * Resolved Turso URL + token bindings for subscriptions and scheduler.
 * @param {"staging"|"production"} target
 */
export function bindingsForTarget(target) {
  const { normalized, bindings } = resolveBindingKeys(target);

  if (normalized === "production") {
    const prodSubsToken = pickFirstEnvOptional(bindings.subscriptions.tokenKeys);
    const stagingSubsToken = pickFirstEnvOptional(STAGING_TURSO_BINDINGS.subscriptions.tokenKeys);
    if (!prodSubsToken && stagingSubsToken) {
      console.warn(
        "[turso-env] Production subscriptions Turso token missing in .env.dev; using TURSO_STAGING_SUBSCRIPTIONS_* (staging DB). Add TURSO_SUBSCRIPTIONS_AUTH_TOKEN or TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN for real production data.",
      );
      return bindingsForTarget("staging");
    }
  }

  return {
    subscriptionsUrl: resolveUrlBinding(normalized, "subscriptions", bindings.subscriptions),
    subscriptionsToken: resolveTokenBinding(normalized, bindings.subscriptions),
    schedulerUrl: resolveUrlBinding(normalized, "scheduler", bindings.scheduler),
    schedulerToken: resolveTokenBinding(normalized, bindings.scheduler),
  };
}

/**
 * Subscriptions DB only (reset-sent-article, send-test).
 * @param {"staging"|"production"} target
 * @returns {{ url: import('./load-env-dev.mjs').EnvPick, token: import('./load-env-dev.mjs').EnvPick, requestedTarget: "staging"|"production", effectiveTarget: "staging"|"production", fellBackToStaging: boolean }}
 */
export function subscriptionsBindingsForTarget(target) {
  const { normalized, bindings } = resolveBindingKeys(target);

  if (normalized === "production") {
    const prodToken = pickFirstEnvOptional(bindings.subscriptions.tokenKeys);
    const stagingToken = pickFirstEnvOptional(STAGING_TURSO_BINDINGS.subscriptions.tokenKeys);
    if (!prodToken && stagingToken) {
      console.warn(
        "[turso-env] Production subscriptions Turso token missing in .env.dev; using TURSO_STAGING_SUBSCRIPTIONS_* (staging DB).",
      );
      const staging = subscriptionsBindingsForTarget("staging");
      return {
        ...staging,
        requestedTarget: "production",
        effectiveTarget: "staging",
        fellBackToStaging: true,
      };
    }
  }

  return {
    url: resolveUrlBinding(normalized, "subscriptions", bindings.subscriptions),
    token: resolveTokenBinding(normalized, bindings.subscriptions),
    requestedTarget: normalized,
    effectiveTarget: normalized,
    fellBackToStaging: false,
  };
}

function formatKeyList(keys) {
  return keys.join(", ");
}

function printTargetReference(target, bindings) {
  console.log(`\n${target}`);
  console.log(`  sync: ${bindings.subscriptions.syncScript}`);
  console.log("");
  console.log("  database       | url keys (first match wins)                          | token keys");
  console.log("  -------------- | ---------------------------------------------------- | ----------------------------------------------------");
  for (const db of ["subscriptions", "scheduler"]) {
    const row = bindings[db];
    const urlCol = formatKeyList(row.urlKeys).padEnd(52);
    const tokenCol = formatKeyList(row.tokenKeys);
    console.log(`  ${db.padEnd(14)} | ${urlCol} | ${tokenCol}`);
  }
}

/**
 * Print .env.dev key names operators need (no secret values).
 * @param {"staging"|"production"|undefined} target - omit to print both
 */
export function printTursoEnvKeyReference(target) {
  console.log("Turso .env.dev keys (from sync scripts; values not shown)");
  if (!target) {
    printTargetReference("staging", STAGING_TURSO_BINDINGS);
    printTargetReference("production", PRODUCTION_TURSO_BINDINGS);
    console.log("\nRefresh: pwsh scripts/sync-staging-turso-env-dev.ps1");
    console.log("         pwsh scripts/sync-production-turso-env-dev.ps1");
    return;
  }
  const normalized = String(target).trim().toLowerCase();
  if (!TARGET_BINDINGS[normalized]) {
    throw new Error(`target must be staging, production, or omitted (got ${JSON.stringify(target)})`);
  }
  printTargetReference(normalized, TARGET_BINDINGS[normalized]);
  console.log(`\nRefresh: pwsh ${TARGET_BINDINGS[normalized].subscriptions.syncScript}`);
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const arg = process.argv[2]?.trim().toLowerCase();
  printTursoEnvKeyReference(arg === "" ? undefined : arg);
}



