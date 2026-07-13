import { count, desc, eq } from 'drizzle-orm';

import {
  createTipsDb,
  storyTipStatuses,
  storyTipsTable,
  type StoryTipStatus,
} from './tips-db';

export type StoryTipRecord = {
  id: string;
  body: string;
  anonymous: boolean;
  contactName: string | null;
  contactEmail: string | null;
  createdAt: string;
  status: StoryTipStatus;
  internalNotes: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

export type StoryTipUpdate = {
  status?: StoryTipStatus;
  internalNotes?: string | null;
  reviewedBy?: string;
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export async function listStoryTips(params: {
  status?: StoryTipStatus;
  limit?: number;
} = {}): Promise<StoryTipRecord[]> {
  const limit = clampLimit(params.limit);
  const { db } = createTipsDb();

  const rows = params.status
    ? await db
        .select()
        .from(storyTipsTable)
        .where(eq(storyTipsTable.status, params.status))
        .orderBy(desc(storyTipsTable.createdAt))
        .limit(limit)
    : await db
        .select()
        .from(storyTipsTable)
        .orderBy(desc(storyTipsTable.createdAt))
        .limit(limit);

  return rows.map(mapStoryTipRow);
}

export async function countStoryTips(status: StoryTipStatus = 'new'): Promise<number> {
  const { db } = createTipsDb();
  const rows = await db
    .select({ value: count() })
    .from(storyTipsTable)
    .where(eq(storyTipsTable.status, status));
  return rows[0]?.value ?? 0;
}

export async function getStoryTip(id: string): Promise<StoryTipRecord | null> {
  const { db } = createTipsDb();
  const rows = await db.select().from(storyTipsTable).where(eq(storyTipsTable.id, id)).limit(1);
  const row = rows[0];
  return row ? mapStoryTipRow(row) : null;
}

export async function updateStoryTip(
  id: string,
  update: StoryTipUpdate,
): Promise<StoryTipRecord | null> {
  const existing = await getStoryTip(id);
  if (!existing) {
    return null;
  }

  const nextStatus = update.status ?? existing.status;
  if (!storyTipStatuses.includes(nextStatus)) {
    throw new Error(`Invalid story tip status: ${nextStatus}`);
  }

  const reviewedAt =
    nextStatus === 'new'
      ? null
      : nextStatus !== existing.status || !existing.reviewedAt
        ? new Date().toISOString()
        : existing.reviewedAt;

  const reviewedBy =
    nextStatus === 'new'
      ? null
      : update.reviewedBy ?? existing.reviewedBy;

  const { db } = createTipsDb();
  await db
    .update(storyTipsTable)
    .set({
      status: nextStatus,
      internalNotes:
        update.internalNotes !== undefined ? update.internalNotes : existing.internalNotes,
      reviewedAt,
      reviewedBy,
    })
    .where(eq(storyTipsTable.id, id));

  return getStoryTip(id);
}

export function parseStoryTipStatus(value: unknown): StoryTipStatus | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return storyTipStatuses.includes(normalized as StoryTipStatus)
    ? (normalized as StoryTipStatus)
    : null;
}

export function parseStoryTipUpdate(payload: unknown): StoryTipUpdate | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const update: StoryTipUpdate = {};

  if ('status' in record) {
    const status = parseStoryTipStatus(record.status);
    if (!status) {
      return null;
    }
    update.status = status;
  }

  if ('internalNotes' in record) {
    if (record.internalNotes === null) {
      update.internalNotes = null;
    } else if (typeof record.internalNotes === 'string') {
      const trimmed = record.internalNotes.trim();
      update.internalNotes = trimmed.length > 0 ? trimmed.slice(0, 4000) : null;
    } else {
      return null;
    }
  }

  if (!('status' in update) && !('internalNotes' in update)) {
    return null;
  }

  return update;
}

function mapStoryTipRow(row: typeof storyTipsTable.$inferSelect): StoryTipRecord {
  return {
    id: row.id,
    body: row.body,
    anonymous: row.anonymous === 1,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    createdAt: row.createdAt,
    status: parseStoryTipStatus(row.status) ?? 'new',
    internalNotes: row.internalNotes,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
  };
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIST_LIMIT);
}
