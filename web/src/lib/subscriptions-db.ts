import { createClient } from '@libsql/client/web';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { readEnv } from './auth';

export const notificationDiagnosticStatuses = ['new', 'reviewed', 'archived'] as const;
export type NotificationDiagnosticStatus = (typeof notificationDiagnosticStatuses)[number];

export const notificationDiagnosticsTable = sqliteTable('notification_diagnostics', {
  id: text('id').primaryKey(),
  payloadJson: text('payload_json').notNull(),
  userNote: text('user_note'),
  createdAt: text('created_at').notNull(),
  status: text('status').notNull().default('new'),
  updatedAt: text('updated_at'),
});

export const pushSubscriptionsTable = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  subscriptionJson: text('subscription_json').notNull(),
  userId: text('user_id'),
  locale: text('locale'),
  userAgent: text('user_agent'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at').notNull(),
  lastSuccessAt: text('last_success_at'),
  lastFailureAt: text('last_failure_at'),
  lastFailureReason: text('last_failure_reason'),
  lastReaderTestAt: text('last_reader_test_at'),
  active: integer('active').notNull(),
});

export function createSubscriptionsDb() {
  const client = createClient({
    url: readEnv('TURSO_SUBSCRIPTIONS_DATABASE_URL'),
    authToken: readEnv('TURSO_SUBSCRIPTIONS_AUTH_TOKEN'),
    fetch: createWorkerSafeFetch(),
  });

  return {
    client,
    db: drizzle(client, {
      schema: {
        pushSubscriptions: pushSubscriptionsTable,
        notificationDiagnostics: notificationDiagnosticsTable,
      },
    }),
  };
}

function createWorkerSafeFetch():
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | undefined {
  if (typeof globalThis.fetch !== 'function') {
    return undefined;
  }

  return (input: RequestInfo | URL, init?: RequestInit) => {
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
  };
}
