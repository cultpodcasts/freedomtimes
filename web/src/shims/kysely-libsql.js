import * as libsql from '@libsql/client/web';
import {
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';

export { libsql };

export class LibsqlDialect {
  #config;

  constructor(config) {
    this.#config = config;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver() {
    let client;
    let closeClient;

    if ('client' in this.#config) {
      client = this.#config.client;
      closeClient = false;
    } else if (this.#config.url !== undefined) {
      const fetchImpl =
        typeof globalThis.fetch === 'function'
          ? (input, init) => {
              if (input && typeof input === 'object' && 'url' in input) {
                return globalThis.fetch(input.url, {
                  method: input.method,
                  headers: input.headers,
                  body: input.body,
                  redirect: input.redirect,
                  signal: input.signal,
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

  createIntrospector(db) {
    return new SqliteIntrospector(db);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
}

export function createDialect(config) {
  return new LibsqlDialect({
    url: config.url,
    authToken: config.authToken,
  });
}

class LibsqlDriver {
  constructor(client, closeClient) {
    this.client = client;
    this.closeClient = closeClient;
  }

  async init() {}

  async acquireConnection() {
    return new LibsqlConnection(this.client);
  }

  async beginTransaction(connection) {
    await connection.beginTransaction();
  }

  async commitTransaction(connection) {
    await connection.commitTransaction();
  }

  async rollbackTransaction(connection) {
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
  #transaction;

  constructor(client) {
    this.client = client;
  }

  async executeQuery(compiledQuery) {
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
