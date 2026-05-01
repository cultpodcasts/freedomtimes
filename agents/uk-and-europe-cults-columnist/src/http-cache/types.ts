export type CachedEntry = {
  fetchedAt: string;
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: string;
};

export type CacheFile = {
  version: 1;
  entries: Record<string, CachedEntry>;
};

export type CachedFetchResult = {
  ok: boolean;
  status: number;
  url: string;
  headers: Record<string, string>;
  text: string;
  fromCache: boolean;
};
