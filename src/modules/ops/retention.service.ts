import { erasuresDue, erasuresPastRetention, purgeExpiredDataExports } from '../account-lifecycle';
import { getConfigObject, saveConfigObject } from '../app-config';
import { ERASURE_DUE_KEY, RETENTION_DUE_KEY } from './ops.keys';
import { notifyAdmins } from './ops.notify';

/**
 * The daily retention sweep — Lot E (decisions 95/126).
 *
 * Two questions, both answered by reading `account-lifecycle` and writing a
 * row this module owns:
 *
 * 1. Which erasure requests are still PENDING past their thirty days? The
 *    admins are told once per request — the `ops:erasure-due` row remembers
 *    who has been told — because the statutory clock has run out and a
 *    request nobody has picked up is a breach, not a backlog.
 *
 * 2. Which erasures are DONE and past `retainUntil` — eight financial years
 *    from the end of the one they completed in (decision 126)? Those people's
 *    financial rows may now be destroyed. May: the sweep writes the list to
 *    `ops:retention-due` and stops. The ledger is append-only, a destruction
 *    is a DPO decision with a signature on it, and nothing in this codebase
 *    deletes a financial row on a timer.
 *
 * `NotificationDelivery` has its own purge, owned by the notifications work
 * (E1); it is not repeated here.
 */

export type RetentionDueItem = {
  erasureId: string;
  userId: string;
  completedAt: string | null;
  retainUntil: string | null;
};

export type RetentionDueReport = {
  generatedAt: string;
  count: number;
  items: RetentionDueItem[];
};

export type RetentionSweepResult = {
  erasureDue: { outstanding: number; notified: string[] };
  retentionDue: { count: number };
  /** G6 (Q104): READY data exports past their seven days — file purged, row EXPIRED; old finished rows deleted. */
  dataExports: { expired: number; deleted: number };
};

type ErasureDueRow = { notified: Record<string, string> };

function readNotified(row: Record<string, unknown> | null): Record<string, string> {
  const notified = row?.['notified'];
  if (!notified || typeof notified !== 'object' || Array.isArray(notified)) return {};
  return Object.fromEntries(
    Object.entries(notified as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export async function retentionSweep(now = new Date()): Promise<RetentionSweepResult> {
  const [due, pastRetention, previous] = await Promise.all([
    erasuresDue(now),
    erasuresPastRetention(now),
    getConfigObject(ERASURE_DUE_KEY),
  ]);

  /* ── 1. Past-due requests: tell the admins once ────────────────── */
  const alreadyTold = readNotified(previous);
  const notified: string[] = [];
  const stillDue = new Set(due.map((request) => request.id));
  // Forget requests that are no longer past due (approved, refused, done), so
  // the row never grows and a request re-opened later is raised afresh.
  const next: ErasureDueRow = {
    notified: Object.fromEntries(Object.entries(alreadyTold).filter(([id]) => stillDue.has(id))),
  };

  for (const request of due) {
    if (alreadyTold[request.id]) continue;
    const overdueDays = Math.floor((now.getTime() - request.dueAt.getTime()) / 86_400_000);
    const told = await notifyAdmins({
      title: 'Erasure request past due',
      subtitle: `${overdueDays} day${overdueDays === 1 ? '' : 's'} over the thirty-day window`,
      message:
        `Erasure request ${request.id} for user ${request.userId} was due on ${request.dueAt.toISOString().slice(0, 10)} ` +
        'and is still pending. The statutory window has run out; approve or refuse it today.',
      suggestedAction: 'Open the erasure queue',
      relatedId: request.id,
    });
    if (told === 0) continue;
    next.notified[request.id] = now.toISOString();
    notified.push(request.id);
  }
  await saveConfigObject(ERASURE_DUE_KEY, next);

  /* ── 2. Past retention: a report, never a deletion ─────────────── */
  const report: RetentionDueReport = {
    generatedAt: now.toISOString(),
    count: pastRetention.length,
    items: pastRetention.map((request) => ({
      erasureId: request.id,
      userId: request.userId,
      completedAt: request.completedAt?.toISOString() ?? null,
      retainUntil: request.retainUntil?.toISOString() ?? null,
    })),
  };
  await saveConfigObject(RETENTION_DUE_KEY, report);

  /* ── 3. G6 (Q104): expired data exports — the one thing the sweep removes,
     a copy the person already has ───────────────────────────────── */
  const dataExports = await purgeExpiredDataExports(now);

  return {
    erasureDue: { outstanding: due.length, notified },
    retentionDue: { count: report.count },
    dataExports,
  };
}
