import * as libsql from '@libsql/client/web';
import { env as cfEnv, waitUntil } from 'cloudflare:workers';
import { kyselyLogOption } from 'emdash/database/instrumentation';
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';

export { libsql };

type DialectConfig = {
  url?: string;
  authToken?: string;
  client?: {
    execute: (args: { sql: string; args?: readonly unknown[] }) => Promise<{
      lastInsertRowid?: bigint | number | string | null;
      rowsAffected?: number;
      rows: unknown[];
    }>;
    transaction: () => Promise<{
      execute: (args: { sql: string; args?: readonly unknown[] }) => Promise<{
        lastInsertRowid?: bigint | number | string | null;
        rowsAffected?: number;
        rows: unknown[];
      }>;
      commit: () => Promise<void>;
      rollback: () => Promise<void>;
    }>;
    close: () => void;
  };
};

export class LibsqlDialect {
  #config: DialectConfig;

  constructor(config: DialectConfig) {
    this.#config = config;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver() {
    let client: any;
    let closeClient: boolean;

    const runtimeEnv = cfEnv as Record<string, string | undefined>;
    const runtimeUrl = runtimeEnv.TURSO_DATABASE_URL?.trim();
    const runtimeAuthToken = runtimeEnv.TURSO_AUTH_TOKEN?.trim();
    const effectiveUrl = runtimeUrl || this.#config.url;
    const effectiveAuthToken = runtimeAuthToken || this.#config.authToken;

    if ('client' in this.#config && this.#config.client) {
      client = this.#config.client;
      closeClient = false;
    } else if (effectiveUrl) {
      const fetchImpl =
        typeof globalThis.fetch === 'function'
          ? (input: RequestInfo | URL, init?: RequestInit) => {
              if (input && typeof input === 'object' && 'url' in input) {
                const request = input as Request;
                return globalThis.fetch(request.url, {
                  method: request.method,
                  headers: request.headers,
                  body: request.body,
                  redirect: request.redirect,
                  signal: request.signal,
                  ...(init || {}),
                });
              }
              return globalThis.fetch(input, init);
            }
          : undefined;
      client = libsql.createClient({
        url: effectiveUrl,
        authToken: effectiveAuthToken,
        fetch: fetchImpl,
      });
      closeClient = true;
    } else {
      throw new Error('Please specify either client or url in the LibsqlDialect config');
    }

    return new LibsqlDriver(client, closeClient);
  }

  createIntrospector(db: unknown) {
    return new SqliteIntrospector(db as any);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
}

export function createDialect(config: { url?: string; authToken?: string }) {
  return new LibsqlDialect({
    url: config.url,
    authToken: config.authToken,
  });
}

/** EmDash optional cold-start dialect; libsql has no session coalescing — reuse createDialect. */
export function createCoalescingDialect(config: { url?: string; authToken?: string }) {
  return createDialect(config);
}

/**
 * Official `RequestScopedDbOpts` (virtual:emdash/dialect). Libsql has no
 * replica/bookmark routing — these fields are unused but typed so the shim
 * matches Hyperdrive / D1 adapters.
 */
type RequestScopedDbOpts = {
  config: unknown;
  isAuthenticated: boolean;
  endedAuthenticated?: () => boolean;
  isWrite: boolean;
  canUseCachedBinding?: boolean;
  cookies: {
    get(name: string): { value: string } | undefined;
    set(name: string, value: string, options: Record<string, unknown>): void;
  };
  url: URL;
  lastContentWriteAt?: number;
};

/**
 * Per-request Kysely + libsql client. Required on Cloudflare Workers: the
 * isolate-wide getDb() client is bound to the first request's fetch, and
 * later HTML requests hang (0 bytes) on workerd's cross-request I/O guard.
 * EmDash middleware then puts this handle in ALS so getDb() / redirect
 * queries stay on this request.
 *
 * Teardown follows Hyperdrive: idempotent `close()`, `waitUntil(destroy)`
 * so workerd does not drop the client close when the response ends.
 */
export function createRequestScopedDb(_opts: RequestScopedDbOpts): {
  db: Kysely<unknown>;
  commit: () => void;
  close: () => void;
} {
  const db = new Kysely({
    dialect: createDialect({}),
    log: kyselyLogOption(),
  });
  let closed = false;
  return {
    db,
    commit() {},
    close() {
      if (closed) return;
      closed = true;
      waitUntil(
        db.destroy().catch((error: unknown) => {
          console.error('[ft-libsql] failed to close request-scoped client:', error);
        }),
      );
    },
  };
}

class LibsqlDriver {
  private client: any;
  private closeClient: boolean;

  constructor(client: any, closeClient: boolean) {
    this.client = client;
    this.closeClient = closeClient;
  }

  async init() {}

  async acquireConnection() {
    return new LibsqlConnection(this.client);
  }

  async beginTransaction(connection: LibsqlConnection) {
    await connection.beginTransaction();
  }

  async commitTransaction(connection: LibsqlConnection) {
    await connection.commitTransaction();
  }

  async rollbackTransaction(connection: LibsqlConnection) {
    await connection.rollbackTransaction();
  }

  async releaseConnection() {}

  async destroy() {
    if (this.closeClient) {
      this.client.close();
    }
  }
}

class LibsqlConnection {
  #transaction: any;
  private client: any;

  constructor(client: any) {
    this.client = client;
  }

  async executeQuery(compiledQuery: { sql: string; parameters: readonly unknown[] }) {
    const target = this.#transaction ?? this.client;
    const result = await target.execute({
      sql: compiledQuery.sql,
      args: compiledQuery.parameters,
    });

    return {
      insertId: result.lastInsertRowid,
      numAffectedRows: BigInt(result.rowsAffected ?? 0),
      rows: result.rows,
    };
  }

  async beginTransaction() {
    if (this.#transaction) {
      throw new Error('Transaction already in progress');
    }

    this.#transaction = await this.client.transaction();
  }

  async commitTransaction() {
    if (!this.#transaction) {
      throw new Error('No transaction to commit');
    }

    await this.#transaction.commit();
    this.#transaction = undefined;
  }

  async rollbackTransaction() {
    if (!this.#transaction) {
      throw new Error('No transaction to rollback');
    }

    await this.#transaction.rollback();
    this.#transaction = undefined;
  }

  async *streamQuery() {
    throw new Error('Libsql Driver does not support streaming yet');
  }
}
