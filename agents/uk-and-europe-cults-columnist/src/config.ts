import { readFileSync } from 'node:fs';
import { AgentEnv } from './types.ts';

type AgentConfig = {
  env: AgentEnv;
  dryRun: boolean;
  allowedSourceHosts: Set<string>;
};

function loadDefaultAllowedHosts(): string[] {
  const configUrl = new URL('../allowed-source-hosts.json', import.meta.url);
  const raw = readFileSync(configUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('allowed-source-hosts.json must be a string array');
  }

  return parsed;
}

const DEFAULT_ALLOWED_HOSTS = loadDefaultAllowedHosts();

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === 'true';
}

export function loadConfig(): AgentConfig {
  const env = (process.env.AGENT_ENV ?? 'staging') as AgentEnv;
  if (env !== 'staging') {
    throw new Error(`AGENT_ENV must be staging. Received: ${env}`);
  }

  const hostsRaw = process.env.ALLOWED_SOURCE_HOSTS;
  const allowedHosts = hostsRaw
    ? hostsRaw
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_ALLOWED_HOSTS;

  return {
    env,
    dryRun: parseBool(process.env.DRY_RUN, true),
    allowedSourceHosts: new Set(allowedHosts),
  };
}
