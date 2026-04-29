import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const schedulerJobsTable = sqliteTable('scheduler_jobs', {
  id: text('id').primaryKey(),
  handler: text('handler').notNull(),
  payload: text('payload').notNull(),
  intervalMinutes: integer('interval_minutes').notNull(),
  nextRunAt: text('next_run_at').notNull(),
  lastRunAt: text('last_run_at'),
  lastError: text('last_error'),
  runCount: integer('run_count').notNull(),
  active: integer('active').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const pushSubscriptionsTable = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  subscriptionJson: text('subscription_json').notNull(),
  userId: text('user_id'),
  locale: text('locale'),
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastSuccessAt: text('last_success_at'),
  lastFailureAt: text('last_failure_at'),
  lastFailureReason: text('last_failure_reason'),
  active: integer('active').notNull(),
});

const schema = {
  schedulerJobs: schedulerJobsTable,
  pushSubscriptions: pushSubscriptionsTable,
};

export type AppDb = ReturnType<typeof createDatabase>['db'];

export function createDatabase(url: string, authToken: string) {
  const client = createClient({ url, authToken });

  return {
    client,
    db: drizzle(client, { schema }),
  };
}