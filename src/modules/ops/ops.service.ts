import { BACKUP_FOLDER, ROTATION_DAYS, dumpDate, newestFirst } from '../../shared/backup';
import { readHeartbeats } from '../../shared/jobs';
import { listPrivateFiles } from '../../shared/storage';
import { getConfigObject } from '../app-config';
import { ERASURE_DUE_KEY, LAST_DRILL_KEY, RETENTION_DUE_KEY } from './ops.keys';
import { prismaOpsRepository as repository } from './prisma-ops.repository';
import type { DrillRecord } from './restore-drill.service';

/**
 * The ops health read — Lot E. Four questions the on-call admin asks before
 * anything else: is there a recent dump, did the last drill pass, what has
 * retention flagged, and is every job still ticking. Read-only; every number
 * comes from something a job or a script already wrote.
 */

/** Decision 95. Stated on the page so the numbers are read against them. */
export const TARGETS = { rpoHours: 1, rtoHours: 4 } as const;

/** A nightly dump older than this is late: one day, plus two hours for the run itself. */
export const BACKUP_STALE_HOURS = 26;
/** No job's interval is longer than an hour; three missed ticks is a stopped process, not a slow one. */
export const JOB_STALE_MINUTES = 180;

export type OpsHealth = {
  targets: typeof TARGETS;
  backup: {
    last: { name: string; takenAt: string | null; size: number } | null;
    count: number;
    ageHours: number | null;
    stale: boolean;
    rotationDays: number;
    error?: string;
  };
  drill: DrillRecord | null;
  retention: { dueCount: number; generatedAt: string | null; erasureOverdue: number };
  jobs: { job: string; lastTickAt: string | null; staleMinutes: number | null; stale: boolean }[];
  /** G11-2: the status page's list — confirmed by link, and still waiting on the confirmation mail. */
  subscribers: { confirmed: number; pending: number };
};

async function backupHealth(now: Date): Promise<OpsHealth['backup']> {
  try {
    const dumps = newestFirst(await listPrivateFiles(BACKUP_FOLDER));
    const newest = dumps[0];
    if (!newest) return { last: null, count: 0, ageHours: null, stale: true, rotationDays: ROTATION_DAYS };
    const takenAt = dumpDate(newest.name);
    const ageHours = takenAt ? Math.floor((now.getTime() - takenAt.getTime()) / 3_600_000) : null;
    return {
      last: { name: newest.name, takenAt: takenAt?.toISOString() ?? null, size: newest.size },
      count: dumps.length,
      ageHours,
      stale: ageHours === null || ageHours >= BACKUP_STALE_HOURS,
      rotationDays: ROTATION_DAYS,
    };
  } catch (err) {
    return {
      last: null,
      count: 0,
      ageHours: null,
      stale: true,
      rotationDays: ROTATION_DAYS,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function opsHealth(now = new Date()): Promise<OpsHealth> {
  const [backup, drill, retentionRow, erasureRow, heartbeats, subscribers] = await Promise.all([
    backupHealth(now),
    getConfigObject(LAST_DRILL_KEY),
    getConfigObject(RETENTION_DUE_KEY),
    getConfigObject(ERASURE_DUE_KEY),
    readHeartbeats(),
    repository.subscriberCounts(),
  ]);

  const notified = erasureRow?.['notified'];
  const erasureOverdue = notified && typeof notified === 'object' && !Array.isArray(notified) ? Object.keys(notified).length : 0;

  return {
    targets: TARGETS,
    backup,
    drill: (drill as DrillRecord | null) ?? null,
    retention: {
      dueCount: asNumber(retentionRow?.['count']),
      generatedAt: typeof retentionRow?.['generatedAt'] === 'string' ? retentionRow['generatedAt'] : null,
      erasureOverdue,
    },
    jobs: heartbeats.map(({ job, lastTickAt }) => {
      const staleMinutes = lastTickAt ? Math.floor((now.getTime() - new Date(lastTickAt).getTime()) / 60_000) : null;
      return { job, lastTickAt, staleMinutes, stale: staleMinutes === null || staleMinutes >= JOB_STALE_MINUTES };
    }),
    subscribers,
  };
}
