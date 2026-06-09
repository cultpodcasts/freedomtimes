import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Feed Config Contract Tests
 *
 * Both agents are seeded from the same feed definitions:
 *   - Node.js agent:  freedomtimes-agents/feeds.json (sibling repo or FREEDOMTIMES_AGENTS_DIR)
 *   - CF worker:      agents/cult-columnist-cf-worker/migrations/0002_seed_config.sql
 *
 * These tests assert both sources stay in sync as feeds are added/removed/modified.
 * A failing test here means the two agents will behave differently in production.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const AGENTS_ROOT = resolve(
  process.env.FREEDOMTIMES_AGENTS_DIR?.trim() || join(REPO_ROOT, '..', 'freedomtimes-agents'),
);

type NodeFeed = {
  id: string;
  url: string;
  sourceFormat: string;
  language: string;
  enabled: boolean;
  requiresUrlResolution: boolean;
};

type SqlFeed = {
  id: string;
  url: string;
  source_format: string;
  language: string;
  enabled: boolean;
  requires_url_resolution: boolean;
};

function loadNodeAgentFeeds(): NodeFeed[] {
  const raw = readFileSync(
    join(AGENTS_ROOT, 'feeds.json'),
    'utf-8',
  );
  return (JSON.parse(raw) as { feeds: NodeFeed[] }).feeds;
}

function loadCfWorkerFeedsFromSql(): SqlFeed[] {
  const sql = readFileSync(
    join(REPO_ROOT, 'agents/cult-columnist-cf-worker/migrations/0002_seed_config.sql'),
    'utf-8',
  );

  const feeds: SqlFeed[] = [];

  // Match lines: INSERT INTO feeds (id, title, url, source_format, source_category, language, requires_url_resolution, url_resolver, enabled)
  // VALUES ('id', 'title', 'url', 'format', 'category', 'lang', 0|1, 'resolver'|NULL, 0|1);
  const insertPattern = /^INSERT INTO feeds \([^)]+\) VALUES \(([^;]+)\);/gm;

  for (const match of sql.matchAll(insertPattern)) {
    // Parse the VALUES(...) tuple — values are either 'quoted' or unquoted (NULL, 0, 1)
    const raw = match[1];
    const values: string[] = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "'" && raw[i - 1] !== '\\') {
        inQuote = !inQuote;
        current += ch;
      } else if (ch === ',' && !inQuote) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());

    const unquote = (v: string) => v.replace(/^'|'$/g, '');

    // Column order: id, title, url, source_format, source_category, language, requires_url_resolution, url_resolver, enabled
    feeds.push({
      id: unquote(values[0]),
      url: unquote(values[2]),
      source_format: unquote(values[3]),
      language: unquote(values[5]),
      requires_url_resolution: values[6] === '1',
      enabled: values[8] === '1',
    });
  }

  return feeds;
}

describe('Feed Config Contract: Node.js agent vs CF worker', () => {
  const nodeFeeds = loadNodeAgentFeeds();
  const cfFeeds = loadCfWorkerFeedsFromSql();

  const nodeById = new Map(nodeFeeds.map((f) => [f.id, f]));
  const cfById = new Map(cfFeeds.map((f) => [f.id, f]));

  it('both sources define the same number of feeds', () => {
    expect(cfFeeds.length).toBe(nodeFeeds.length);
  });

  it('both sources contain exactly the same feed IDs', () => {
    const nodeIds = [...nodeById.keys()].sort();
    const cfIds = [...cfById.keys()].sort();
    expect(cfIds).toEqual(nodeIds);
  });

  it('every feed URL matches between sources', () => {
    const mismatches: string[] = [];
    for (const [id, nodeFeed] of nodeById) {
      const cfFeed = cfById.get(id);
      if (!cfFeed) continue;
      if (nodeFeed.url !== cfFeed.url) {
        mismatches.push(`${id}: node="${nodeFeed.url}" cf="${cfFeed.url}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every feed source format matches between sources', () => {
    const mismatches: string[] = [];
    for (const [id, nodeFeed] of nodeById) {
      const cfFeed = cfById.get(id);
      if (!cfFeed) continue;
      if (nodeFeed.sourceFormat !== cfFeed.source_format) {
        mismatches.push(`${id}: node="${nodeFeed.sourceFormat}" cf="${cfFeed.source_format}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every feed language matches between sources', () => {
    const mismatches: string[] = [];
    for (const [id, nodeFeed] of nodeById) {
      const cfFeed = cfById.get(id);
      if (!cfFeed) continue;
      if (nodeFeed.language !== cfFeed.language) {
        mismatches.push(`${id}: node="${nodeFeed.language}" cf="${cfFeed.language}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every feed enabled flag matches between sources', () => {
    const mismatches: string[] = [];
    for (const [id, nodeFeed] of nodeById) {
      const cfFeed = cfById.get(id);
      if (!cfFeed) continue;
      if (nodeFeed.enabled !== cfFeed.enabled) {
        mismatches.push(`${id}: node=${nodeFeed.enabled} cf=${cfFeed.enabled}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every feed requiresUrlResolution flag matches between sources', () => {
    const mismatches: string[] = [];
    for (const [id, nodeFeed] of nodeById) {
      const cfFeed = cfById.get(id);
      if (!cfFeed) continue;
      if (nodeFeed.requiresUrlResolution !== cfFeed.requires_url_resolution) {
        mismatches.push(`${id}: node=${nodeFeed.requiresUrlResolution} cf=${cfFeed.requires_url_resolution}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
