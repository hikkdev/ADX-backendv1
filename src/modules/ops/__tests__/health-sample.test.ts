import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsRepository } from '../ops.repository';

/**
 * Lot G (Q130): the five-minute sample — five rows a tick, every failure
 * named without a URL, thirty days kept — and the per-service series the
 * history page draws from them.
 */
const { repository } = vi.hoisted(() => ({
  repository: {
    writeSamples: vi.fn(),
    latestSamples: vi.fn(),
    dailyHealth: vi.fn(),
    pruneSamples: vi.fn(),
    createIncident: vi.fn(),
    findIncident: vi.fn(),
    listIncidents: vi.fn(),
    openIncidents: vi.fn(),
    latestIncidentAt: vi.fn(),
    addUpdate: vi.fn(),
    patchIncident: vi.fn(),
    findSubscriberByEmail: vi.fn(),
    findSubscriberByToken: vi.fn(),
    upsertSubscriber: vi.fn(),
    confirmSubscriber: vi.fn(),
    deleteSubscriber: vi.fn(),
    confirmedSubscribers: vi.fn(),
    subscriberCounts: vi.fn(),
  } satisfies Record<keyof OpsRepository, ReturnType<typeof vi.fn>>,
}));

vi.mock('../prisma-ops.repository', () => ({ prismaOpsRepository: repository }));
vi.mock('../../app-config', () => ({ getConfigObject: vi.fn(), getPlatformSettings: vi.fn() }));
vi.mock('../../../shared/storage', () => ({ listPrivateFiles: vi.fn(), probeStorage: vi.fn() }));

import { JOB_NAMES } from '../../../shared/jobs';
import { probeAll, sampleHealth, serviceHistory, staleJobs, type HealthProbes } from '../health-sample.service';

const NOW = new Date('2026-09-14T03:00:00Z');
const fresh = (job: string) => ({ job, lastTickAt: new Date(NOW.getTime() - 60_000).toISOString() });

function probes(over: Partial<HealthProbes> = {}): HealthProbes {
  return {
    api: async () => ({ p95Ms: 120, count: 40 }),
    postgres: async () => ({ ok: true, latencyMs: 8 }),
    redis: async () => ({ ok: true, latencyMs: 2 }),
    storage: async () => ({ ok: true, provider: 'r2', latencyMs: 90 }),
    heartbeats: async () => JOB_NAMES.map(fresh),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repository.writeSamples.mockImplementation(async (rows: unknown[]) => rows.length);
  repository.pruneSamples.mockResolvedValue(0);
});

describe('probeAll', () => {
  it('writes one OK row per service when everything answers', async () => {
    const rows = await probeAll(NOW, probes());
    expect(rows.map((r) => r.service)).toEqual(['API', 'POSTGRES', 'REDIS', 'STORAGE', 'JOBS']);
    expect(rows.every((r) => r.ok && r.at === NOW)).toBe(true);
    expect(rows[0]).toMatchObject({ latencyMs: 120, detail: '40 requests' });
    expect(rows[1]).toMatchObject({ latencyMs: 8, detail: null });
    expect(rows[3]).toMatchObject({ latencyMs: 90, detail: 'r2' });
    expect(rows[4]).toMatchObject({ latencyMs: null, detail: `${JOB_NAMES.length} jobs fresh` });
  });

  it('a minute with no traffic is an OK API sample with no latency, not a failure', async () => {
    const [api] = await probeAll(NOW, probes({ api: async () => ({ p95Ms: null, count: 0 }) }));
    expect(api).toMatchObject({ service: 'API', ok: true, latencyMs: null, detail: 'no requests in the minute' });
  });

  it('names a failing ping and a stale job, and never carries a URL', async () => {
    const rows = await probeAll(
      NOW,
      probes({
        postgres: async () => ({ ok: false, error: 'postgres ping exceeded 3000ms' }),
        storage: async () => ({ ok: false, provider: 'r2', latencyMs: 5000, error: 'HeadBucket failed for https://acct.r2.cloudflarestorage.com/bucket' }),
        heartbeats: async () => [...JOB_NAMES.filter((j) => j !== 'retention' && j !== 'restore-drill').map(fresh), { job: 'retention', lastTickAt: new Date(NOW.getTime() - 200 * 60_000).toISOString() }],
      }),
    );
    expect(rows[1]).toMatchObject({ service: 'POSTGRES', ok: false, latencyMs: null, detail: 'postgres ping exceeded 3000ms' });
    expect(rows[3]).toMatchObject({ service: 'STORAGE', ok: false, detail: 'r2: HeadBucket failed for [url]' });
    expect(rows[4]).toMatchObject({ service: 'JOBS', ok: false, detail: 'stale: retention, restore-drill' });
  });

  it('a probe that throws is a failed sample for that service only', async () => {
    const rows = await probeAll(
      NOW,
      probes({
        redis: async () => {
          throw new Error('ECONNREFUSED redis://user:pw@host:6379');
        },
      }),
    );
    expect(rows[2]).toMatchObject({ service: 'REDIS', ok: false });
    expect(rows[2]!.detail).not.toContain('pw@host');
    expect(rows.filter((r) => r.ok)).toHaveLength(4);
  });
});

describe('staleJobs', () => {
  it('counts a job that never ticked as stale, and one at 180 minutes', () => {
    const beats = JOB_NAMES.filter((j) => j !== 'kyc-purge').map(fresh);
    const stale = staleJobs([...beats.filter((b) => b.job !== 'retention'), { job: 'retention', lastTickAt: new Date(NOW.getTime() - 180 * 60_000).toISOString() }], NOW);
    expect(stale).toEqual(['kyc-purge', 'retention']);
  });
});

describe('sampleHealth', () => {
  it('writes the five rows and prunes past thirty days', async () => {
    repository.pruneSamples.mockResolvedValue(1440);
    const result = await sampleHealth(NOW, probes());
    expect(result).toMatchObject({ written: 5, pruned: 1440 });
    expect(repository.writeSamples).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ service: 'API' })]));
    expect(repository.pruneSamples).toHaveBeenCalledWith(new Date('2026-08-15T03:00:00.000Z'));
  });
});

describe('serviceHistory', () => {
  it('answers thirty Indian days per service, oldest first, a day with no samples reading null', async () => {
    repository.dailyHealth.mockResolvedValue([
      { service: 'API', date: '2026-09-13', okPct: 100, p95Ms: 130 },
      { service: 'API', date: '2026-09-14', okPct: 99.7, p95Ms: 210 },
      { service: 'JOBS', date: '2026-09-14', okPct: 100, p95Ms: null },
    ]);
    const history = await serviceHistory(NOW, 30);
    // 03:00 UTC on the 14th is the 14th in IST; thirty days back is the 16th of August.
    expect(repository.dailyHealth).toHaveBeenCalledWith(new Date('2026-08-15T18:30:00.000Z'));
    expect(Object.keys(history)).toEqual(['API', 'POSTGRES', 'REDIS', 'STORAGE', 'JOBS']);
    expect(history.API.days).toHaveLength(30);
    expect(history.API.days[0]).toEqual({ date: '2026-08-16', okPct: null, p95Ms: null });
    expect(history.API.days[28]).toEqual({ date: '2026-09-13', okPct: 100, p95Ms: 130 });
    expect(history.API.days[29]).toEqual({ date: '2026-09-14', okPct: 99.7, p95Ms: 210 });
    expect(history.JOBS.days[29]).toEqual({ date: '2026-09-14', okPct: 100, p95Ms: null });
    expect(history.REDIS.days.every((d) => d.okPct === null)).toBe(true);
  });
});
