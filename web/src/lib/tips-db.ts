import { createClient } from '@libsql/client/web';
import { drizzle } from 'drizzle-orm/libsql';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { readEnv } from './auth';

export const storyTipStatuses = ['new', 'reviewed', 'archived'] as const;
export type StoryTipStatus = (typeof storyTipStatuses)[number];

export const storyTipsTable = sqliteTable('story_tips', {
  id: text('id').primaryKey(),
  body: text('body').notNull(),
  anonymous: integer('anonymous').notNull(),
  contactName: text('contact_name'),
  contactEmail: text('contact_email'),
  createdAt: text('created_at').notNull(),
  status: text('status').notNull().default('new'),
  internalNotes: text('internal_notes'),
  reviewedAt: text('reviewed_at'),
  reviewedBy: text('reviewed_by'),
});

export function createTipsDb() {
  const client = createClient({
    url: readEnv('TURSO_TIPS_DATABASE_URL'),
    authToken: readEnv('TURSO_TIPS_AUTH_TOKEN'),
    fetch: createWorkerSafeFetch(),
  });

  return {
    client,
    db: drizzle(client, {
      schema: {
        storyTips: storyTipsTable,
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
