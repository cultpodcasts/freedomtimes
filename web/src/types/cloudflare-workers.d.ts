interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

declare module 'cloudflare:workers' {
  interface AnalyticsEngineDataPoint {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }

  interface AnalyticsEngineDataset {
    writeDataPoint(event?: AnalyticsEngineDataPoint): void;
  }

  export const env: Record<
    string,
    string | KVNamespace | R2Bucket | AnalyticsEngineDataset | undefined
  >;

  export function waitUntil(promise: Promise<unknown>): void;
}
