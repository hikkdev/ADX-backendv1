import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The monthly restore drill — Lot E (decision 95).
 *
 * A backup nobody has restored is a hope. Once a month the newest dump is
 * opened, restored into a scratch database and the ledger verify is run
 * against what came back; the result is a row the ops page reads, an audit
 * row, and — on failure — a notification to every admin.
 */

const { appConfig, audit, users, notifications } = vi.hoisted(() => ({
  appConfig: { getConfigObject: vi.fn(), saveConfigObject: vi.fn() },
  audit: { logActivity: vi.fn() },
  users: { listAdminUserIds: vi.fn() },
  notifications: { createNotification: vi.fn() },
}));

vi.mock('../../app-config', () => appConfig);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);

import { runRestoreDrill, type DrillDeps } from '../restore-drill.service';
import { LAST_DRILL_KEY } from '../ops.keys';

const NOW = new Date('2026-10-01T02:30:00Z');
const PRODUCTION = 'postgresql://u:p@ep-live.neon.tech/adx?sslmode=require';
const SCRATCH = 'postgresql://u:p@ep-live.neon.tech/adx_drill?sslmode=require';
const KEY = 'a'.repeat(64);

const dump = (name: string, size = 1024) => ({ storageKey: `r2:private/backups/${name}`, name, size, lastModified: null });

function deps(over: Partial<DrillDeps> = {}): DrillDeps {
  return {
    drillUrl: SCRATCH,
    productionUrl: PRODUCTION,
    backupKey: KEY,
    actorId: 'adm_1',
    workDir: path.join(os.tmpdir(), 'adx-drill-test'),
    listDumps: vi.fn().mockResolvedValue([dump('2026-09-29T02-00-00Z.dump.enc'), dump('2026-09-30T02-00-00Z.dump.enc', 2048), { storageKey: 'r2:private/backups/notes.txt', name: 'notes.txt', size: 3, lastModified: null }]),
    download: vi.fn().mockResolvedValue(undefined),
    decrypt: vi.fn().mockResolvedValue(undefined),
    gunzip: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue({ warnings: null }),
    query: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  appConfig.saveConfigObject.mockImplementation(async (_k: string, v: unknown) => v);
  users.listAdminUserIds.mockResolvedValue(['adm_1', 'adm_2']);
  notifications.createNotification.mockResolvedValue({});
});

describe('runRestoreDrill', () => {
  it('skips with a warning, writing nothing, when there is no scratch database', async () => {
    const result = await runRestoreDrill(deps({ drillUrl: undefined }), NOW);
    expect(result.status).toBe('SKIPPED');
    expect(result.reason).toMatch(/DRILL_DATABASE_URL/);
    expect(appConfig.saveConfigObject).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('refuses to restore into the production database, and says so loudly', async () => {
    const d = deps({ drillUrl: PRODUCTION });
    const result = await runRestoreDrill(d, NOW);
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatch(/production/i);
    expect(d.restore).not.toHaveBeenCalled();
    expect(d.download).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    expect(appConfig.saveConfigObject).toHaveBeenCalledWith(LAST_DRILL_KEY, expect.objectContaining({ status: 'FAILED' }));
  });

  it('restores the newest dump, runs the ledger verify and records a pass', async () => {
    const d = deps();
    const result = await runRestoreDrill(d, NOW);

    expect(result.status).toBe('PASSED');
    expect(d.download).toHaveBeenCalledWith('r2:private/backups/2026-09-30T02-00-00Z.dump.enc', expect.stringContaining('2026-09-30T02-00-00Z.dump.enc'));
    expect(d.decrypt).toHaveBeenCalledTimes(1);
    expect(d.gunzip).toHaveBeenCalledTimes(1);
    expect(d.restore).toHaveBeenCalledWith(SCRATCH, expect.stringMatching(/\.dump$/));
    // Two verify queries — the unbalanced transactions and the wallet drift — against the scratch database only.
    expect(d.query).toHaveBeenCalledTimes(2);
    for (const call of (d.query as ReturnType<typeof vi.fn>).mock.calls) expect(call[0]).toBe(SCRATCH);
    expect(d.query).toHaveBeenCalledWith(SCRATCH, expect.stringContaining('"LedgerLeg"'));
    expect(d.query).toHaveBeenCalledWith(SCRATCH, expect.stringContaining('"Wallet"'));

    expect(appConfig.saveConfigObject).toHaveBeenCalledWith(LAST_DRILL_KEY, {
      ranAt: NOW.toISOString(),
      status: 'PASSED',
      dump: { name: '2026-09-30T02-00-00Z.dump.enc', size: 2048 },
      durationMs: expect.any(Number),
      ledger: { unbalanced: 0, drift: 0, healthy: true },
      warnings: null,
      error: null,
    });
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'BACKUP_DRILL_RUN', expect.objectContaining({
      module: 'ops',
      targetType: 'AppConfig',
      targetId: LAST_DRILL_KEY,
      metadata: expect.objectContaining({ status: 'PASSED', dump: '2026-09-30T02-00-00Z.dump.enc' }),
    }));
    expect(notifications.createNotification).not.toHaveBeenCalled();
    // The working files are cleaned up either way.
    expect(d.remove).toHaveBeenCalled();
  });

  it('fails the drill when the restored ledger does not verify, and tells every admin', async () => {
    const d = deps({
      query: vi.fn()
        .mockResolvedValueOnce([{ transactionId: 'tx_1', total: '5.00' }])
        .mockResolvedValueOnce([]),
    });
    const result = await runRestoreDrill(d, NOW);
    expect(result.status).toBe('FAILED');
    expect(result.ledger).toEqual({ unbalanced: 1, drift: 0, healthy: false });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restore drill failed', userId: 'adm_2' }));
    expect(appConfig.saveConfigObject).toHaveBeenCalledWith(LAST_DRILL_KEY, expect.objectContaining({ status: 'FAILED', ledger: { unbalanced: 1, drift: 0, healthy: false } }));
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'BACKUP_DRILL_RUN', expect.objectContaining({ metadata: expect.objectContaining({ status: 'FAILED' }) }));
  });

  it('fails when there is no dump to restore, and when the restore itself throws', async () => {
    const none = await runRestoreDrill(deps({ listDumps: vi.fn().mockResolvedValue([]) }), NOW);
    expect(none.status).toBe('FAILED');
    expect(none.error).toMatch(/no dump/i);

    const broken = await runRestoreDrill(deps({ restore: vi.fn().mockRejectedValue(new Error('pg_restore exited with 2: boom')) }), NOW);
    expect(broken.status).toBe('FAILED');
    expect(broken.error).toContain('pg_restore exited with 2');
    expect(appConfig.saveConfigObject).toHaveBeenLastCalledWith(LAST_DRILL_KEY, expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('pg_restore') }));
  });

  it('refuses without the backup key rather than trying to open a dump', async () => {
    const d = deps({ backupKey: undefined });
    const result = await runRestoreDrill(d, NOW);
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatch(/BACKUP_KEY/);
    expect(d.download).not.toHaveBeenCalled();
  });

  it('keeps a restore warning on the row when the ledger still verifies', async () => {
    const d = deps({ restore: vi.fn().mockResolvedValue({ warnings: 'pg_restore: warning: errors ignored on restore: 1' }) });
    const result = await runRestoreDrill(d, NOW);
    expect(result.status).toBe('PASSED');
    expect(result.warnings).toContain('errors ignored');
  });

  it('runs without an actor, only skipping the audit row', async () => {
    const result = await runRestoreDrill(deps({ actorId: null }), NOW);
    expect(result.status).toBe('PASSED');
    expect(audit.logActivity).not.toHaveBeenCalled();
    expect(appConfig.saveConfigObject).toHaveBeenCalled();
  });
});
