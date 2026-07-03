import { desc } from 'drizzle-orm';

import type { NotificationDiagnosticSnapshot } from './notification-diagnostics-server';
import { createSubscriptionsDb, notificationDiagnosticsTable } from './subscriptions-db';

export type NotificationDiagnosticRecord = {
  id: string;
  createdAt: string;
  userNote: string | null;
  snapshot: NotificationDiagnosticSnapshot | null;
};

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export async function listNotificationDiagnostics(params: {
  limit?: number;
} = {}): Promise<NotificationDiagnosticRecord[]> {
  const limit = clampLimit(params.limit);
  const { db } = createSubscriptionsDb();

  const rows = await db
    .select()
    .from(notificationDiagnosticsTable)
    .orderBy(desc(notificationDiagnosticsTable.createdAt))
    .limit(limit);

  return rows.map(mapNotificationDiagnosticRow);
}

function mapNotificationDiagnosticRow(
  row: typeof notificationDiagnosticsTable.$inferSelect,
): NotificationDiagnosticRecord {
  return {
    id: row.id,
    createdAt: row.createdAt,
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
