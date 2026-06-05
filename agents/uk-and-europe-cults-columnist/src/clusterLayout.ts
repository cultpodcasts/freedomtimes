import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type LayoutCluster = {
  id: string;
  label: string;
  urls: string[];
};

export type ClusterLayout = {
  updatedAt: string;
  clusters: LayoutCluster[];
  independentUrls: string[];
};

export type LayoutStoryGroup<TStory extends { url: string }> = {
  id?: string;
  label: string;
  type: 'detected' | 'independent';
  stories: TStory[];
};

const LAYOUT_PATH = new URL('../data/feedback/cluster-layout.json', import.meta.url);
const APPROVED_LAYOUT_PATH = new URL('../reports/approved-layout.json', import.meta.url);

export function layoutFilePath(): string {
  return fileURLToPath(LAYOUT_PATH);
}

export function approvedLayoutFilePath(): string {
  return fileURLToPath(APPROVED_LAYOUT_PATH);
}

export function storyUrlKey(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return rawUrl.trim().replace(/\/$/, '').toLowerCase();
  }
}

export function loadClusterLayout(): ClusterLayout | null {
  if (!existsSync(LAYOUT_PATH)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(LAYOUT_PATH, 'utf-8')) as ClusterLayout;
    if (!parsed || !Array.isArray(parsed.clusters) || !Array.isArray(parsed.independentUrls)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveClusterLayout(layout: ClusterLayout): void {
  mkdirSync(new URL('../data/feedback/', import.meta.url), { recursive: true });
  writeFileSync(LAYOUT_PATH, `${JSON.stringify(layout, null, 2)}\n`, 'utf-8');
}

export function saveApprovedLayout(layout: ClusterLayout): void {
  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(APPROVED_LAYOUT_PATH, `${JSON.stringify(layout, null, 2)}\n`, 'utf-8');
}

export function seedLayoutFromGroups<TStory extends { url: string }>(
  groups: LayoutStoryGroup<TStory>[],
): ClusterLayout {
  const clusters: LayoutCluster[] = [];
  const independentUrls: string[] = [];

  groups.forEach((group, index) => {
    if (group.type === 'independent') {
      for (const story of group.stories) {
        independentUrls.push(story.url);
      }
      return;
    }
    clusters.push({
      id: group.id ?? `auto-${index}-${slugifyLabel(group.label)}`,
      label: group.label,
      urls: group.stories.map((story) => story.url),
    });
  });

  return {
    updatedAt: new Date().toISOString(),
    clusters,
    independentUrls,
  };
}

function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'cluster';
}

export function applyClusterLayout<TStory extends { url: string }>(
  autoGroups: LayoutStoryGroup<TStory>[],
  stories: TStory[],
  layout: ClusterLayout | null,
): LayoutStoryGroup<TStory>[] {
  if (!layout || (layout.clusters.length === 0 && layout.independentUrls.length === 0)) {
    return autoGroups;
  }

  const storyByKey = new Map(stories.map((story) => [storyUrlKey(story.url), story]));
  const layoutedKeys = new Set<string>();

  const manualGroups: LayoutStoryGroup<TStory>[] = [];
  for (const cluster of layout.clusters) {
    const clusterStories: TStory[] = [];
    for (const url of cluster.urls) {
      const key = storyUrlKey(url);
      layoutedKeys.add(key);
      const story = storyByKey.get(key);
      if (story) {
        clusterStories.push(story);
      }
    }
    if (clusterStories.length > 0) {
      manualGroups.push({
        id: cluster.id,
        label: cluster.label.trim() || 'Cluster',
        type: 'detected',
        stories: clusterStories,
      });
    }
  }

  const manualIndependent: TStory[] = [];
  for (const url of layout.independentUrls) {
    const key = storyUrlKey(url);
    layoutedKeys.add(key);
    const story = storyByKey.get(key);
    if (story) {
      manualIndependent.push(story);
    }
  }

  const autoDetected: LayoutStoryGroup<TStory>[] = [];
  const autoIndependent: TStory[] = [];

  for (const group of autoGroups) {
    const remaining = group.stories.filter((story) => !layoutedKeys.has(storyUrlKey(story.url)));
    if (remaining.length === 0) {
      continue;
    }
    if (group.type === 'independent') {
      autoIndependent.push(...remaining);
      continue;
    }
    if (remaining.length >= 2) {
      autoDetected.push({ label: group.label, type: 'detected', stories: remaining });
    } else {
      autoIndependent.push(...remaining);
    }
  }

  const independentSeen = new Set<string>();
  const allIndependent = [...autoIndependent, ...manualIndependent].filter((story) => {
    const key = storyUrlKey(story.url);
    if (independentSeen.has(key)) {
      return false;
    }
    independentSeen.add(key);
    return true;
  });

  const result: LayoutStoryGroup<TStory>[] = [...manualGroups, ...autoDetected];
  if (allIndependent.length > 0) {
    result.push({
      label: 'Independent Journalism',
      type: 'independent',
      stories: allIndependent,
    });
  }
  return result;
}
