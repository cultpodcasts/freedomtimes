import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Pipeline Contract Test: Node.js agent vs CF Worker
 *
 * This test assumes:
 *  - D1 database has been dropped and recreated using the latest migrations/seed
 *  - The pipeline has been run to completion in both agents (Node.js and CF Worker)
 *  - Candidate extraction output is available for both agents as JSON files
 *
 * Place the Node.js agent output at: test/fixtures/node-candidates.json
 * Place the CF Worker output at:    test/fixtures/cf-candidates.json
 */

type Candidate = {
  feedId: string;
  rawUrl: string;
  title: string | null;
  pubDate: string | null;
};

const nodeFixturePath = join(__dirname, 'fixtures', 'node-candidates.json');
const cfFixturePath = join(__dirname, 'fixtures', 'cf-candidates.json');
const fixturesExist = existsSync(nodeFixturePath) && existsSync(cfFixturePath);

function loadCandidates(path: string): Candidate[] {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe.skipIf(!fixturesExist)('Pipeline Contract: Node.js agent vs CF Worker', () => {
  const nodeCandidates = fixturesExist ? loadCandidates(nodeFixturePath) : [];
  const cfCandidates = fixturesExist ? loadCandidates(cfFixturePath) : [];

  it('should produce the same set of candidate stories', () => {
    // Compare by feedId + rawUrl (ignore order)
    const nodeSet = new Set(nodeCandidates.map(c => `${c.feedId}|${c.rawUrl}`));
    const cfSet = new Set(cfCandidates.map(c => `${c.feedId}|${c.rawUrl}`));
    expect(cfSet).toEqual(nodeSet);
  });

  it('should produce the same titles and pubDates for each candidate', () => {
    const nodeMap = new Map(nodeCandidates.map(c => [`${c.feedId}|${c.rawUrl}`, c]));
    const cfMap = new Map(cfCandidates.map(c => [`${c.feedId}|${c.rawUrl}`, c]));
    for (const key of nodeMap.keys()) {
      expect(cfMap.has(key)).toBe(true);
      const nodeC = nodeMap.get(key)!;
      const cfC = cfMap.get(key)!;
      expect(cfC.title).toBe(nodeC.title);
      expect(cfC.pubDate).toBe(nodeC.pubDate);
    }
  });
});
