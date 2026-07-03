import { desc, eq } from 'drizzle-orm';

import type { NotificationDiagnosticSnapshot } from './notification-diagnostics-server';
import {
  createSubscriptionsDb,
  notificationDiagnosticStatuses,
  notificationDiagnosticsTable,
  type NotificationDiagnosticStatus,
} from './subscriptions-db';

export type NotificationDiagnosticRecord = {
  id: string;
  createdAt: string;
  updatedAt: string | null;
  status: NotificationDiagnosticStatus;
  userNote: string | null;
  snapshot: NotificationDiagnosticSnapshot | null;
};

export type NotificationDiagnosticUpdate = {
  status: NotificationDiagnosticStatus;
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_STATUS: NotificationDiagnosticStatus = 'new';

export async function listNotificationDiagnostics(params: {
  status?: NotificationDiagnosticStatus | 'all';
  limit?: number;
} = {}): Promise<NotificationDiagnosticRecord[]> {
  const limit = clampLimit(params.limit);
  const statusFilter = params.status ?? DEFAULT_LIST_STATUS;
  const { db } = createSubscriptionsDb();

  const rows =
    statusFilter === 'all'
      ? await db
          .select()
          .from(notificationDiagnosticsTable)
          .orderBy(desc(notificationDiagnosticsTable.createdAt))
          .limit(limit)
      : await db
          .select()
          .from(notificationDiagnosticsTable)
          .where(eq(notificationDiagnosticsTable.status, statusFilter))
          .orderBy(desc(notificationDiagnosticsTable.createdAt))
          .limit(limit);

  return rows.map(mapNotificationDiagnosticRow);
}

export async function getNotificationDiagnostic(
  id: string,
): Promise<NotificationDiagnosticRecord | null> {
  const { db } = createSubscriptionsDb();
  const rows = await db
    .select()
    .from(notificationDiagnosticsTable)
    .where(eq(notificationDiagnosticsTable.id, id))
    .limit(1);
  const row = rows[0];
  return row ? mapNotificationDiagnosticRow(row) : null;
}

export async function updateNotificationDiagnostic(
  id: string,
  update: NotificationDiagnosticUpdate,
): Promise<NotificationDiagnosticRecord | null> {
  const existing = await getNotificationDiagnostic(id);
  if (!existing) {
    return null;
  }

  if (!notificationDiagnosticStatuses.includes(update.status)) {
    throw new Error(`Invalid notification diagnostic status: ${update.status}`);
  }

  const { db } = createSubscriptionsDb();
  await db
    .update(notificationDiagnosticsTable)
    .set({
      status: update.status,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(notificationDiagnosticsTable.id, id));

  return getNotificationDiagnostic(id);
}

export function parseNotificationDiagnosticStatus(
  value: unknown,
): NotificationDiagnosticStatus | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return notificationDiagnosticStatuses.includes(normalized as NotificationDiagnosticStatus)
    ? (normalized as NotificationDiagnosticStatus)
    : null;
}

export function parseNotificationDiagnosticListStatus(
  value: unknown,
): NotificationDiagnosticStatus | 'all' | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'all') {
    return 'all';
  }

  return parseNotificationDiagnosticStatus(normalized);
}

export function parseNotificationDiagnosticUpdate(
  payload: unknown,
): NotificationDiagnosticUpdate | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (!('status' in record)) {
    return null;
  }

  const status = parseNotificationDiagnosticStatus(record.status);
  if (!status) {
    return null;
  }

  return { status };
}

function mapNotificationDiagnosticRow(
  row: typeof notificationDiagnosticsTable.$inferSelect,
): NotificationDiagnosticRecord {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? null,
    status: parseNotificationDiagnosticStatus(row.status) ?? 'new',
    userNote: row.userNote,
    snapshot: parseSnapshotJson(row.payloadJson),
  };
}

function parseSnapshotJson(value: string): NotificationDiagnosticSnapshot | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as NotificationDiagnosticSnapshot;
  } catch {
    return null;
  }
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIST_LIMIT);
}
