import * as libsql from '@libsql/client/web';
import {
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

    if ('client' in this.#config && this.#config.client) {
      client = this.#config.client;
      closeClient = false;
    } else if (this.#config.url !== undefined) {
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
        ...this.#config,
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
      numAffectedRows: BigInt(result.rowsAffected),
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
