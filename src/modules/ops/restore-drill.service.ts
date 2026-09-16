import fs from 'fs';
import os from 'os';
import path from 'path';
import { logActivity } from '../../shared/audit';
import {
  decryptToPlain,
  gunzipFile,
  isProductionDatabase,
  newestFirst,
  parseBackupKey,
  pgRestore,
  queryDatabase,
  BACKUP_FOLDER,
} from '../../shared/backup';
import { logger } from '../../shared/logging';
import { downloadPrivateFile, listPrivateFiles, type StoredObject } from '../../shared/storage';
import { env } from '../../config/env';
import { saveConfigObject } from '../app-config';
import { LAST_DRILL_KEY } from './ops.keys';
import { notifyAdmins } from './ops.notify';

/**
 * The monthly restore drill — Lot E (decision 95: RPO 1 h / RTO 4 h).
 *
 * Neon's point-in-time restore is the RPO; the nightly dump in R2 is the
 * copy that survives Neon; and this is what proves the copy can be opened.
 * The newest dump is downloaded, unsealed, restored into a scratch database
 * and the ledger verify — the same two queries `ledger.verifyLedger` runs
 * on the live books — is run against what came back. A dump that restores
 * but whose books do not balance is a failed drill: the data is there, the
 * platform behind it would not be.
 *
 * The scratch database is DRILL_DATABASE_URL. Unset, the drill skips with a
 * warning and writes nothing — a missing drill on the ops page is the
 * signal. Named like production, the drill refuses before a byte moves.
 *
 * Every step is injectable so the shape can be tested without pg_restore,
 * R2 or a scratch server; the job composes the real ones.
 */

export type DrillDeps = {
  drillUrl: string | undefined;
  productionUrl: string;
  backupKey: string | undefined;
  /** Whose audit row it is — `users.systemUserId()` (E7-2), or null when the system account cannot be ensured. */
  actorId: string | null;
  workDir: string;
  listDumps(): Promise<StoredObject[]>;
  download(storageKey: string, toPath: string): Promise<void>;
  decrypt(src: string, dst: string, key: Buffer): Promise<void>;
  gunzip(src: string, dst: string): Promise<void>;
  restore(url: string, dumpPath: string): Promise<{ warnings: string | null }>;
  query(url: string, sql: string): Promise<Record<string, unknown>[]>;
  remove(dir: string): Promise<void>;
};

export type LedgerCheck = { unbalanced: number; drift: number; healthy: boolean };

export type DrillStatus = 'PASSED' | 'FAILED' | 'SKIPPED';

/** What `ops:last-drill` holds. */
export type DrillRecord = {
  ranAt: string;
  status: Exclude<DrillStatus, 'SKIPPED'>;
  dump: { name: string; size: number } | null;
  durationMs: number;
  ledger: LedgerCheck | null;
  warnings: string | null;
  error: string | null;
};

export type DrillOutcome = {
  status: DrillStatus;
  reason?: string;
  dump?: { name: string; size: number } | null;
  ledger?: LedgerCheck | null;
  warnings?: string | null;
  error?: string | null;
};

/**
 * The ledger verify, as plain SQL. The same statements as
 * `modules/ledger/prisma-ledger.repository.ts` — `findUnbalanced` and
 * `findWalletDrift` — which cannot be reused here because they are bound to
 * the app's Prisma client, and the whole point is to ask a different
 * database. If one changes, change the other.
 */
export const LEDGER_VERIFY_SQL = {
  unbalanced: `
    SELECT "transactionId", SUM("amount") AS total
      FROM "LedgerLeg"
     GROUP BY "transactionId"
    HAVING SUM("amount") <> 0
  `,
  drift: `
    SELECT w."id" AS "walletId",
           (w."balance" + w."goodwill") AS "walletTotal",
           COALESCE(SUM(l."amount"), 0) AS "ledgerTotal"
      FROM "Wallet" w
      JOIN "LedgerAccount" a ON a."walletId" = w."id"
      LEFT JOIN "LedgerLeg" l ON l."accountId" = a."id"
     GROUP BY w."id", w."balance", w."goodwill"
    HAVING (w."balance" + w."goodwill") <> COALESCE(SUM(l."amount"), 0)
  `,
} as const;

export function defaultDrillDeps(actorId: string | null): DrillDeps {
  return {
    drillUrl: env.DRILL_DATABASE_URL,
    productionUrl: env.DIRECT_URL ?? env.DATABASE_URL,
    backupKey: env.BACKUP_KEY,
    actorId,
    workDir: path.join(os.tmpdir(), 'adx-restore-drill'),
    listDumps: () => listPrivateFiles(BACKUP_FOLDER),
    download: downloadPrivateFile,
    decrypt: decryptToPlain,
    gunzip: gunzipFile,
    restore: pgRestore,
    query: queryDatabase,
    remove: (dir) => fs.promises.rm(dir, { recursive: true, force: true }),
  };
}

async function verifyLedgerAt(deps: DrillDeps, url: string): Promise<LedgerCheck> {
  const [unbalanced, drift] = await Promise.all([
    deps.query(url, LEDGER_VERIFY_SQL.unbalanced),
    deps.query(url, LEDGER_VERIFY_SQL.drift),
  ]);
  return { unbalanced: unbalanced.length, drift: drift.length, healthy: unbalanced.length === 0 && drift.length === 0 };
}

export async function runRestoreDrill(deps: DrillDeps, now = new Date()): Promise<DrillOutcome> {
  if (!deps.drillUrl) {
    const reason = 'DRILL_DATABASE_URL is not set: the monthly restore drill did not run';
    logger.warn(reason, { tag: 'restoreDrill' });
    return { status: 'SKIPPED', reason };
  }

  const started = Date.now();
  let dump: { name: string; size: number } | null = null;
  let ledger: LedgerCheck | null = null;
  let warnings: string | null = null;
  let error: string | null = null;
  const runDir = path.join(deps.workDir, now.toISOString().replace(/[:.]/g, '-'));

  try {
    if (isProductionDatabase(deps.drillUrl, deps.productionUrl)) {
      throw new Error('DRILL_DATABASE_URL names the production database; a drill never restores into it');
    }
    const key = parseBackupKey(deps.backupKey);

    const newest = newestFirst(await deps.listDumps())[0];
    if (!newest) throw new Error('No dump to restore: the backups folder is empty');
    dump = { name: newest.name, size: newest.size };

    await fs.promises.mkdir(runDir, { recursive: true });
    const sealed = path.join(runDir, newest.name);
    const gz = path.join(runDir, 'dump.gz');
    const plain = path.join(runDir, 'restore.dump');

    await deps.download(newest.storageKey, sealed);
    await deps.decrypt(sealed, gz, key);
    await deps.gunzip(gz, plain);
    warnings = (await deps.restore(deps.drillUrl, plain)).warnings;
    ledger = await verifyLedgerAt(deps, deps.drillUrl);
    if (!ledger.healthy) {
      error = `The restored ledger does not verify: ${ledger.unbalanced} unbalanced transaction(s), ${ledger.drift} wallet(s) adrift`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await deps.remove(runDir).catch(() => undefined);
  }

  const status: DrillRecord['status'] = error ? 'FAILED' : 'PASSED';
  const record: DrillRecord = {
    ranAt: now.toISOString(),
    status,
    dump,
    durationMs: Date.now() - started,
    ledger,
    warnings,
    error,
  };
  await saveConfigObject(LAST_DRILL_KEY, record);

  if (deps.actorId) {
    await logActivity(deps.actorId, 'BACKUP_DRILL_RUN', {
      module: 'ops',
      targetType: 'AppConfig',
      targetId: LAST_DRILL_KEY,
      metadata: { status, dump: dump?.name ?? null, durationMs: record.durationMs, ledger, error },
    });
  } else {
    logger.warn('Restore drill ran with no system user to attribute the audit row to', { tag: 'restoreDrill' });
  }

  if (status === 'FAILED') {
    logger.error('Restore drill failed', { tag: 'restoreDrill', dump: dump?.name ?? null, error });
    await notifyAdmins({
      title: 'Restore drill failed',
      subtitle: dump ? dump.name : 'no dump',
      message: `The monthly restore drill failed: ${error}. Until it passes, the nightly dump cannot be relied on for the 4-hour RTO. See docs/runbooks/backup-restore.md.`,
      suggestedAction: 'Open the ops health page',
      relatedId: LAST_DRILL_KEY,
    });
  } else {
    logger.info('Restore drill passed', { tag: 'restoreDrill', dump: dump?.name, durationMs: record.durationMs, warnings: warnings !== null });
  }

  return { status, dump, ledger, warnings, error };
}
