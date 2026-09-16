import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Feature flags — Lot A (Q31), rebuilt around the registry in Lot G
 * (answers 144-146).
 *
 * The rules worth holding onto: an unknown key is false, never a guess, and
 * a declared key with no row yet answers from its launch default; a
 * percentage rollout is deterministic, so a person does not see the feature
 * come and go between two taps; named accounts win over every other rule;
 * a switch never moves without a row saying who moved it; a patch that
 * names one field leaves the others alone; a rollback restores exactly the
 * position before the last write and can itself be rolled back.
 */

const { repository, cache, audit, registryFile } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    listState: vi.fn(),
    find: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    changes: vi.fn(),
    createRegistered: vi.fn(),
    updateRegistered: vi.fn(),
    foldLegacy: vi.fn(),
  },
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  registryFile: { readRegistryDocument: vi.fn<() => unknown>(() => null), resetRegistryDocumentForTests: vi.fn() },
}));

vi.mock('../prisma-feature-flags.repository', () => ({ prismaFeatureFlagsRepository: repository }));
vi.mock('../../../shared/cache', () => cache);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('../registry-file', () => registryFile);

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { authenticate, signAccessToken } from '../../../shared/auth';
import { feature, resetRegistryForTests, type RegistryDocument, type RegistryEntry } from '../../../shared/features';
import { checkRegistry, compareRegistryDocuments } from '../registry-check';
import { appFlagsRouter, flagRouter } from '../feature-flags.routes';
import { registerFlagUserLabelPort } from '../user-labels.port';
import { registerFlagSubjectCityPort } from '../subject.port';
import { registerFlagChangePort } from '../flag-change.port';
import { requireFeature, requireFeatureWhen } from '../require-feature';
import {
  FLAG_STATE_CACHE_KEY,
  FLAG_STATE_TTL_SECONDS,
  bucketFor,
  ensureFeatureRegistry,
  evaluate,
  evaluateAllFor,
  isFeatureEnabled,
  parseRollout,
  rollbackFlag,
  setFlag,
  type FlagState,
} from '../feature-flags.service';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/flags', flagRouter);
  api.use('/app/flags', appFlagsRouter);
  api.get('/gated', requireFeature('campaigns.landing-pages'), (_req, res) => res.json({ ok: true }));
  api.get('/gated-dark', requireFeature('marketplace.instant-booking'), (_req, res) => res.json({ ok: true }));
  // The way a module mounts it: behind authenticate, so the rollout rules see the token.
  api.get('/gated-auth', authenticate, requireFeature('campaigns.landing-pages'), (_req, res) => res.json({ ok: true }));
  // G10: a write gated only when the body asks for the feature — a listing write that opts into instant booking.
  api.post(
    '/gated-when',
    requireFeatureWhen('marketplace.instant-booking', (req) => req.body?.instantBooking === true),
    (_req, res) => res.json({ ok: true }),
  );
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'admin-1');
const publisher = tokenFor(['PUBLISHER'], 'pub-7');
/** An admin whose token carries a resolved permission list that lacks system.flags. */
const adminWithoutRollback = signAccessToken('admin-2', ['ADMIN'], undefined, { perms: ['settings.view', 'settings.edit'] });

const state = (over: Partial<FlagState> & { key: string }): FlagState => ({
  enabled: true,
  rolloutPercent: 100,
  variant: null,
  variants: [],
  rollout: null,
  surfaces: ['APP_USER', 'APP_AGENT', 'CONSOLE'],
  ...over,
});

const flagRow = (over: Record<string, unknown> = {}) => ({
  key: 'marketplace.instant-booking',
  enabled: false,
  rolloutPercent: 100,
  description: 'Q6',
  updatedById: null,
  surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
  kind: 'FEATURE',
  source: 'REGISTERED',
  owner: 'marketplace',
  variant: null,
  variants: [],
  rollout: null,
  lastGoodState: null,
  registeredAt: new Date('2026-09-13T00:00:00.000Z'),
  createdAt: new Date('2026-09-12T00:00:00.000Z'),
  updatedAt: new Date('2026-09-12T00:00:00.000Z'),
  changes: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRegistryForTests();
  registerFlagSubjectCityPort(async () => null);
  registerFlagChangePort(() => undefined);
  cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  repository.listState.mockResolvedValue([
    state({ key: 'marketplace.instant-booking', enabled: false, surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'] }),
    state({ key: 'campaigns.multi-market', surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'] }),
    state({ key: 'publisher.spot-insights', rolloutPercent: 50, surfaces: ['APP_USER', 'BACKEND'] }),
    state({ key: 'campaigns.landing-pages', variants: ['classic', 'builder'], variant: 'builder' }),
    state({ key: 'system.roles', surfaces: ['CONSOLE'] }),
  ]);
  repository.list.mockResolvedValue([flagRow()]);
  repository.find.mockImplementation(async (key: string) => (key === 'marketplace.instant-booking' ? flagRow() : null));
  repository.update.mockImplementation(async (key: string, next: Record<string, unknown>, change: Record<string, unknown>) =>
    flagRow({
      ...next,
      key,
      changes: [{ id: 'chg-1', flagKey: key, enabled: next['enabled'], rolloutPercent: next['rolloutPercent'], variant: next['variant'], rollout: next['rollout'], byUserId: 'admin-1', note: change['note'], rollbackOfId: change['rollbackOfId'] }],
    }),
  );
  repository.changes.mockResolvedValue([]);
  repository.foldLegacy.mockResolvedValue(false);
  // L-B: the batch write — one row per write, each carrying the change just written.
  repository.updateMany.mockImplementation(async (writes: { key: string; next: Record<string, unknown>; change: Record<string, unknown> }[]) =>
    writes.map(({ key, next, change }, index) =>
      flagRow({
        ...next,
        key,
        changes: [{ id: `chg-b${index + 1}`, flagKey: key, enabled: next['enabled'], rolloutPercent: next['rolloutPercent'], variant: next['variant'], rollout: next['rollout'], byUserId: 'admin-1', note: change['note'], rollbackOfId: change['rollbackOfId'] }],
      }),
    ),
  );
});

describe('the evaluation', () => {
  it('is off for an unknown key, and for a flag that is simply off', () => {
    expect(evaluate(undefined, 'usr-1')).toEqual({ enabled: false, variant: null });
    expect(evaluate(state({ key: 'f', enabled: false }), 'usr-1').enabled).toBe(false);
  });

  it('is on for everyone at 100 — subject or not — and nobody at 0', () => {
    expect(evaluate(state({ key: 'f' })).enabled).toBe(true);
    expect(evaluate(state({ key: 'f', rolloutPercent: 0 }), 'usr-1').enabled).toBe(false);
  });

  it('carries the variant when on, and never when off', () => {
    const flag = state({ key: 'f', variants: ['a', 'b'], variant: 'b' });
    expect(evaluate(flag, 'usr-1')).toEqual({ enabled: true, variant: 'b' });
    expect(evaluate({ ...flag, enabled: false }, 'usr-1')).toEqual({ enabled: false, variant: null });
  });

  it('buckets a partial rollout deterministically, and refuses an anonymous caller', () => {
    const flag = state({ key: 'publisher.spot-insights', rolloutPercent: 50 });
    const first = evaluate(flag, 'usr-1').enabled;
    expect(evaluate(flag, 'usr-1').enabled).toBe(first);
    expect(first).toBe(bucketFor(flag.key, 'usr-1') < 50);
    // No subject: no stable bucket, so no.
    expect(evaluate(flag, null).enabled).toBe(false);
  });

  it('spreads buckets across the range rather than clustering', () => {
    const on = Array.from({ length: 400 }, (_, i) => bucketFor('publisher.spot-insights', `usr-${i}`) < 25).filter(
      Boolean,
    ).length;
    // 25% of 400 is 100; a hash that clustered would be nowhere near.
    expect(on).toBeGreaterThan(60);
    expect(on).toBeLessThan(145);
  });

  /** Answer 146: named accounts first, then the percentage, the roles and the city, each an AND. */
  describe('the rollout rules', () => {
    it('puts a named account on regardless of the percentage, and everyone else off', () => {
      const flag = state({ key: 'f', rolloutPercent: 0, rollout: { userIds: ['usr-vip'], roles: ['ADMIN'] } });
      expect(evaluate(flag, { id: 'usr-vip', roles: ['PUBLISHER'] }).enabled).toBe(true);
      expect(evaluate(flag, { id: 'usr-other', roles: ['ADMIN'] }).enabled).toBe(false);
      expect(evaluate(flag, null).enabled).toBe(false);
    });

    it('narrows by role: the caller needs one of the roles named', () => {
      const flag = state({ key: 'f', rollout: { roles: ['PUBLISHER', 'AGENT_PUBLISHER'] } });
      expect(evaluate(flag, { id: 'u', roles: ['PUBLISHER'] }).enabled).toBe(true);
      expect(evaluate(flag, { id: 'u', roles: ['ADVERTISER'] }).enabled).toBe(false);
      expect(evaluate(flag, { id: 'u' }).enabled).toBe(false);
    });

    it('narrows by city, case-insensitively, and is closed when the city is unknown', () => {
      const flag = state({ key: 'f', rollout: { cities: ['Bengaluru', 'Pune'] } });
      expect(evaluate(flag, { id: 'u', city: 'bengaluru' }).enabled).toBe(true);
      expect(evaluate(flag, { id: 'u', city: 'Mumbai' }).enabled).toBe(false);
      expect(evaluate(flag, { id: 'u', city: null }).enabled).toBe(false);
    });

    it('ANDs the percentage with the roles and the city', () => {
      const flag = state({ key: 'f', rolloutPercent: 50, rollout: { roles: ['PUBLISHER'], cities: ['Pune'] } });
      const inBucket = Array.from({ length: 200 }, (_, i) => `usr-${i}`).find((id) => bucketFor('f', id) < 50)!;
      const outOfBucket = Array.from({ length: 200 }, (_, i) => `usr-${i}`).find((id) => bucketFor('f', id) >= 50)!;
      expect(evaluate(flag, { id: inBucket, roles: ['PUBLISHER'], city: 'Pune' }).enabled).toBe(true);
      expect(evaluate(flag, { id: outOfBucket, roles: ['PUBLISHER'], city: 'Pune' }).enabled).toBe(false);
      expect(evaluate(flag, { id: inBucket, roles: ['ADVERTISER'], city: 'Pune' }).enabled).toBe(false);
      expect(evaluate(flag, { id: inBucket, roles: ['PUBLISHER'], city: 'Delhi' }).enabled).toBe(false);
    });

    it('reads a stored rollout defensively', () => {
      expect(parseRollout(null)).toBeNull();
      expect(parseRollout('junk')).toBeNull();
      expect(parseRollout({ roles: [], cities: 'Pune', userIds: [1, 'u-1'] })).toEqual({ userIds: ['u-1'] });
    });
  });

  it('reads the table through a 30-second cache and resolves a legacy alias to its registry key', async () => {
    expect(await isFeatureEnabled('campaigns.multi-market', 'usr-1')).toBe(true);
    expect(await isFeatureEnabled('multi-market-campaigns', 'usr-1')).toBe(true);
    expect(await isFeatureEnabled('instant-booking', 'usr-1')).toBe(false);
    expect(await isFeatureEnabled('no-such-flag', 'usr-1')).toBe(false);
    expect(cache.readThrough).toHaveBeenCalledWith(FLAG_STATE_CACHE_KEY, FLAG_STATE_TTL_SECONDS, expect.any(Function));
  });

  it('still answers a legacy row that has not been folded yet', async () => {
    repository.listState.mockResolvedValue([state({ key: 'multi-market-campaigns', surfaces: [] })]);
    expect(await isFeatureEnabled('multi-market-campaigns', 'usr-1')).toBe(true);
    expect(await isFeatureEnabled('campaigns.multi-market', 'usr-1')).toBe(true);
  });

  it('answers a declared feature with no row yet from its launch default — the boot window', async () => {
    feature('orders.new-thing', { surfaces: ['APP_USER'], owner: 'marketplace', kind: 'FEATURE', launch: 'on', description: 'x' });
    feature('orders.dark-thing', { surfaces: ['APP_USER'], owner: 'marketplace', kind: 'FEATURE', launch: 'dark', description: 'x' });
    expect(await isFeatureEnabled('orders.new-thing', 'usr-1')).toBe(true);
    expect(await isFeatureEnabled('orders.dark-thing', 'usr-1')).toBe(false);
  });

  it('asks the city port only when a rule needs a city, and passes the roles through', async () => {
    const port = vi.fn(async () => 'Pune');
    registerFlagSubjectCityPort(port);
    expect(await isFeatureEnabled('campaigns.multi-market', 'usr-1', { roles: ['PUBLISHER'] })).toBe(true);
    expect(port).not.toHaveBeenCalled();

    repository.listState.mockResolvedValue([state({ key: 'campaigns.multi-market', rollout: { cities: ['Pune'] } })]);
    expect(await isFeatureEnabled('campaigns.multi-market', 'usr-1')).toBe(true);
    expect(port).toHaveBeenCalledWith('usr-1');

    port.mockRejectedValue(new Error('down'));
    expect(await isFeatureEnabled('campaigns.multi-market', 'usr-2')).toBe(false);
  });

  it('answers the app surfaces for one caller, with the flat boolean under each legacy key', async () => {
    const mine = await evaluateAllFor('usr-1');
    expect(Object.keys(mine).sort()).toEqual([
      'campaigns.landing-pages',
      'campaigns.multi-market',
      'instant-booking',
      'marketplace.instant-booking',
      'multi-market-campaigns',
      'publisher-spot-insights',
      'publisher.spot-insights',
    ]);
    // A console-only feature is not the apps' business.
    expect(mine['system.roles']).toBeUndefined();
    expect(mine['campaigns.multi-market']).toEqual({ enabled: true, variant: null });
    expect(mine['campaigns.landing-pages']).toEqual({ enabled: true, variant: 'builder' });
    expect(mine['multi-market-campaigns']).toBe(true);
    expect(mine['instant-booking']).toBe(false);
  });
});

describe('moving a flag', () => {
  it('leaves the other fields where they are when only the switch is named, and keeps the previous position as lastGoodState', async () => {
    repository.find.mockResolvedValue(flagRow({ enabled: false, rolloutPercent: 25, variant: 'a', variants: ['a', 'b'], rollout: { roles: ['PUBLISHER'] } }));
    await setFlag('marketplace.instant-booking', { enabled: true }, 'admin-1');
    expect(repository.update).toHaveBeenCalledWith(
      'marketplace.instant-booking',
      {
        enabled: true,
        rolloutPercent: 25,
        variant: 'a',
        rollout: { roles: ['PUBLISHER'] },
        lastGoodState: { enabled: false, rolloutPercent: 25, variant: 'a', rollout: { roles: ['PUBLISHER'] } },
      },
      { byUserId: 'admin-1', note: null, rollbackOfId: null },
    );
    expect(cache.invalidate).toHaveBeenCalledWith(FLAG_STATE_CACHE_KEY);
  });

  it('accepts a variant only from the row\'s list, and null to clear it', async () => {
    repository.find.mockResolvedValue(flagRow({ variants: ['classic', 'builder'], variant: 'classic' }));
    await expect(setFlag('marketplace.instant-booking', { variant: 'nope' }, 'admin-1')).rejects.toMatchObject({ statusCode: 400 });
    await setFlag('marketplace.instant-booking', { variant: 'builder' }, 'admin-1');
    expect(repository.update.mock.calls[0]![1]).toMatchObject({ variant: 'builder' });
    await setFlag('marketplace.instant-booking', { variant: null }, 'admin-1');
    expect(repository.update.mock.calls[1]![1]).toMatchObject({ variant: null });
  });

  it('cleans a rollout on the way in and clears it with null', async () => {
    await setFlag('marketplace.instant-booking', { rollout: { roles: ['PUBLISHER', 'PUBLISHER'], cities: [], userIds: ['u-1'] } }, 'admin-1');
    expect(repository.update.mock.calls[0]![1]).toMatchObject({ rollout: { roles: ['PUBLISHER'], userIds: ['u-1'] } });
    await setFlag('marketplace.instant-booking', { rollout: null }, 'admin-1');
    expect(repository.update.mock.calls[1]![1]).toMatchObject({ rollout: null });
  });

  it('is a 404 for a key that does not exist — flags are created by the registry, not by PATCH', async () => {
    repository.find.mockResolvedValue(null);
    await expect(setFlag('invented.thing', { enabled: true }, 'admin-1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('accepts a legacy alias and writes the registry key', async () => {
    await setFlag('instant-booking', { enabled: true }, 'admin-1');
    expect(repository.find).toHaveBeenCalledWith('marketplace.instant-booking');
    expect(repository.update.mock.calls[0]![0]).toBe('marketplace.instant-booking');
  });

  it('fires the flag change port after the write, and survives a listener that throws', async () => {
    const listener = vi.fn(async () => {
      throw new Error('push down');
    });
    registerFlagChangePort(listener);
    await setFlag('marketplace.instant-booking', { enabled: true }, 'admin-1');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ flag: expect.objectContaining({ key: 'marketplace.instant-booking', enabled: true }), changeId: 'chg-1', byUserId: 'admin-1', rollback: false }),
    );
  });
});

describe('rolling a flag back', () => {
  it('restores lastGoodState, keeps the current position as the new lastGoodState, and names the change it undid', async () => {
    repository.find.mockResolvedValue(
      flagRow({ enabled: true, rolloutPercent: 10, variant: 'builder', variants: ['builder'], lastGoodState: { enabled: false, rolloutPercent: 100, variant: null, rollout: null } }),
    );
    repository.changes.mockResolvedValue([{ id: 'chg-9', byUserId: 'admin-1' }]);
    const listener = vi.fn();
    registerFlagChangePort(listener);

    const { restored } = await rollbackFlag('marketplace.instant-booking', 'admin-1', 'It broke checkout');
    expect(restored).toEqual({ enabled: false, rolloutPercent: 100, variant: null, rollout: null });
    expect(repository.update).toHaveBeenCalledWith(
      'marketplace.instant-booking',
      { enabled: false, rolloutPercent: 100, variant: null, rollout: null, lastGoodState: { enabled: true, rolloutPercent: 10, variant: 'builder', rollout: null } },
      { byUserId: 'admin-1', note: 'It broke checkout', rollbackOfId: 'chg-9' },
    );
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ rollback: true }));
  });

  it('is a 409 when the flag has never moved', async () => {
    await expect(rollbackFlag('marketplace.instant-booking', 'admin-1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the boot upsert', () => {
  it('folds the legacy rows, creates a row per declaration (on unless dark), refreshes REGISTERED rows and never touches a MANUAL one', async () => {
    feature('orders.new-thing', { surfaces: ['APP_USER'], owner: 'marketplace', kind: 'FEATURE', launch: 'on', description: 'new' });
    feature('orders.dark-thing', { surfaces: ['APP_USER'], owner: 'marketplace', kind: 'EXPERIMENT', launch: 'dark', description: 'dark', variants: ['a', 'b'] });
    feature('marketplace.instant-booking', { surfaces: ['APP_USER', 'BACKEND'], owner: 'marketplace', kind: 'FEATURE', launch: 'dark', description: 'Q6', aliases: ['instant-booking'] });
    feature('ops.manual-thing', { surfaces: ['CONSOLE'], owner: 'platform', kind: 'FEATURE', launch: 'on', description: 'manual' });
    repository.foldLegacy.mockImplementation(async (oldKey: string) => oldKey === 'instant-booking');
    repository.list.mockResolvedValue([
      flagRow({ key: 'marketplace.instant-booking', source: 'REGISTERED' }),
      flagRow({ key: 'ops.manual-thing', source: 'MANUAL' }),
    ]);

    const result = await ensureFeatureRegistry();

    expect(result.folded).toEqual(['instant-booking']);
    expect(result.created).toEqual(['orders.dark-thing', 'orders.new-thing']);
    expect(result.updated).toBe(1);
    expect(result.skipped).toEqual(['ops.manual-thing']);
    expect(repository.createRegistered).toHaveBeenCalledWith(expect.objectContaining({ key: 'orders.new-thing', enabled: true, kind: 'FEATURE' }));
    expect(repository.createRegistered).toHaveBeenCalledWith(expect.objectContaining({ key: 'orders.dark-thing', enabled: false, variants: ['a', 'b'] }));
    expect(repository.updateRegistered).toHaveBeenCalledWith(expect.objectContaining({ key: 'marketplace.instant-booking', surfaces: ['APP_USER', 'BACKEND'] }));
    expect(repository.updateRegistered).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'ops.manual-thing' }));
    expect(cache.invalidate).toHaveBeenCalledWith(FLAG_STATE_CACHE_KEY);
  });

  it('G12-B: unions a declaration\'s variants with the committed document\'s, so a variant declared server-side is accepted before a manifest sync', async () => {
    feature('marketplace.instant-booking', { surfaces: ['APP_USER', 'BACKEND'], owner: 'marketplace', kind: 'FEATURE', launch: 'dark', description: 'Q6', variants: ['default', 'recommended'] });
    feature('campaigns.multi-market', { surfaces: ['APP_USER', 'BACKEND'], owner: 'demand', kind: 'FEATURE', launch: 'dark', description: 'Q8', variants: ['default', 'unwarned'] });
    registryFile.readRegistryDocument.mockReturnValue({
      generatedBy: 'scripts/features-sync.ts',
      featureCount: 2,
      features: [
        { key: 'marketplace.instant-booking', surfaces: ['APP_USER', 'BACKEND'], kind: 'FEATURE', owner: 'marketplace', launch: 'dark', description: 'Q6', variants: ['recommended', 'legacy'], aliases: [], routes: [], jobs: [], paths: {}, declaredIn: ['backend', 'APP_USER'] },
        { key: 'campaigns.multi-market', surfaces: ['APP_USER', 'BACKEND'], kind: 'FEATURE', owner: 'demand', launch: 'dark', description: 'Q8', variants: [], aliases: [], routes: [], jobs: [], paths: {}, declaredIn: ['backend'] },
      ],
    });
    repository.list.mockResolvedValue([flagRow({ key: 'marketplace.instant-booking', source: 'REGISTERED', variants: ['recommended'] })]);

    await ensureFeatureRegistry();

    expect(repository.updateRegistered).toHaveBeenCalledWith(expect.objectContaining({ key: 'marketplace.instant-booking', variants: ['default', 'recommended', 'legacy'] }));
    expect(repository.createRegistered).toHaveBeenCalledWith(expect.objectContaining({ key: 'campaigns.multi-market', variants: ['default', 'unwarned'] }));
  });

  it('widens a declaration with the committed document\'s surfaces and registers manifest-only features too', async () => {
    feature('campaigns.landing-pages', { surfaces: ['APP_USER', 'BACKEND'], owner: 'demand', kind: 'FEATURE', launch: 'on', description: 'x' });
    registryFile.readRegistryDocument.mockReturnValue({
      generatedBy: 'scripts/features-sync.ts',
      featureCount: 2,
      features: [
        { key: 'campaigns.landing-pages', surfaces: ['APP_USER', 'CONSOLE', 'BACKEND'], kind: 'FEATURE', owner: 'demand', launch: 'on', description: 'x', variants: [], aliases: [], routes: [], jobs: [], paths: { CONSOLE: ['campaigns/landing-pages'] }, declaredIn: ['backend', 'CONSOLE'] },
        { key: 'console.dashboard', surfaces: ['CONSOLE'], kind: 'FEATURE', owner: 'platform', launch: 'on', description: 'The home screen', variants: [], aliases: [], routes: [], jobs: [], paths: { CONSOLE: ['dashboard'] }, declaredIn: ['CONSOLE'] },
      ],
    });
    repository.list.mockResolvedValue([]);

    const result = await ensureFeatureRegistry();
    expect(result.created).toEqual(['campaigns.landing-pages', 'console.dashboard']);
    expect(repository.createRegistered).toHaveBeenCalledWith(expect.objectContaining({ key: 'campaigns.landing-pages', surfaces: ['APP_USER', 'BACKEND', 'CONSOLE'] }));
    expect(repository.createRegistered).toHaveBeenCalledWith(expect.objectContaining({ key: 'console.dashboard', surfaces: ['CONSOLE'], enabled: true }));
  });
});

describe('the routes', () => {
  it('are ADMIN-only for the ops surface', async () => {
    expect((await request(app()).get('/api/v1/flags')).status).toBe(401);
    expect((await request(app()).get('/api/v1/flags').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
  });

  it('lists flags with the registry columns, the aliases and the change that last moved each', async () => {
    repository.list.mockResolvedValue([
      flagRow({ rollout: { roles: ['PUBLISHER'] }, changes: [{ id: 'chg-9', flagKey: 'marketplace.instant-booking', enabled: true, rolloutPercent: 10, byUserId: 'admin-1' }] }),
    ]);
    const res = await request(app()).get('/api/v1/flags').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      key: 'marketplace.instant-booking',
      surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'],
      kind: 'FEATURE',
      source: 'REGISTERED',
      owner: 'marketplace',
      variant: null,
      variants: [],
      rollout: { roles: ['PUBLISHER'] },
      aliases: ['instant-booking'],
      registeredAt: '2026-09-13T00:00:00.000Z',
    });
    expect(res.body.data[0].lastChange.id).toBe('chg-9');
    expect(res.body.data[0].changes).toBeUndefined();
  });

  it('writes a change on PATCH and on PUT, and audits it as FEATURE_FLAG_CHANGED', async () => {
    const res = await request(app())
      .patch('/api/v1/flags/marketplace.instant-booking')
      .set('Authorization', `Bearer ${admin}`)
      .send({ enabled: true, rolloutPercent: 10, note: 'Pilot with two publishers' });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.lastChange.id).toBe('chg-1');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'FEATURE_FLAG_CHANGED',
      expect.objectContaining({
        module: 'feature-flags',
        targetType: 'FeatureFlag',
        targetId: 'marketplace.instant-booking',
        metadata: { note: 'Pilot with two publishers' },
      }),
    );

    const put = await request(app())
      .put('/api/v1/flags/marketplace.instant-booking')
      .set('Authorization', `Bearer ${admin}`)
      .send({ rollout: { cities: ['Pune'] } });
    expect(put.status).toBe(200);
    expect(repository.update).toHaveBeenCalledTimes(2);
  });

  it('refuses a body that names nothing, a percentage off the scale, a role in lower case and an unknown rollout key', async () => {
    const send = (body: object) =>
      request(app()).patch('/api/v1/flags/marketplace.instant-booking').set('Authorization', `Bearer ${admin}`).send(body);
    expect((await send({ note: 'nothing to do' })).status).toBe(400);
    expect((await send({ rolloutPercent: 140 })).status).toBe(400);
    expect((await send({ rollout: { roles: ['publisher'] } })).status).toBe(400);
    expect((await send({ rollout: { emails: ['a@b.c'] } })).status).toBe(400);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('rolls back under system.flags, audited as FEATURE_FLAG_ROLLED_BACK, and refuses an admin without it', async () => {
    repository.find.mockResolvedValue(flagRow({ enabled: true, lastGoodState: { enabled: false, rolloutPercent: 100, variant: null, rollout: null } }));
    repository.changes.mockResolvedValue([{ id: 'chg-9', byUserId: 'admin-1' }]);

    const denied = await request(app())
      .post('/api/v1/flags/marketplace.instant-booking/rollback')
      .set('Authorization', `Bearer ${adminWithoutRollback}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.missing).toEqual(['system.flags']);

    const res = await request(app())
      .post('/api/v1/flags/marketplace.instant-booking/rollback')
      .set('Authorization', `Bearer ${admin}`)
      .send({ note: 'Checkout broke' });
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.lastChange.rollbackOfId).toBe('chg-9');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'FEATURE_FLAG_ROLLED_BACK',
      expect.objectContaining({
        targetType: 'FeatureFlag',
        targetId: 'marketplace.instant-booking',
        metadata: expect.objectContaining({ rollbackOfId: 'chg-9', note: 'Checkout broke' }),
      }),
    );
  });

  it('serves every signed-in caller their own answers at /app/flags, in both shapes', async () => {
    expect((await request(app()).get('/api/v1/app/flags')).status).toBe(401);

    const res = await request(app()).get('/api/v1/app/flags').set('Authorization', `Bearer ${publisher}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data['campaigns.multi-market']).toEqual({ enabled: true, variant: null });
    expect(res.body.data['multi-market-campaigns']).toBe(true);
    expect(res.body.data['publisher-spot-insights']).toBe(bucketFor('publisher.spot-insights', 'pub-7') < 50);
    expect(res.body.data['system.roles']).toBeUndefined();
  });

  it('serves the registry document merged with the rows at /flags/registry', async () => {
    registryFile.readRegistryDocument.mockReturnValue({
      generatedBy: 'scripts/features-sync.ts',
      featureCount: 2,
      features: [
        { key: 'console.dashboard', surfaces: ['CONSOLE'], kind: 'FEATURE', owner: 'platform', launch: 'on', description: 'home', variants: [], aliases: [], routes: [], jobs: [], paths: { CONSOLE: ['dashboard'] }, declaredIn: ['CONSOLE'] },
        { key: 'marketplace.instant-booking', surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'], kind: 'FEATURE', owner: 'marketplace', launch: 'dark', description: 'Q6', variants: [], aliases: ['instant-booking'], routes: [], jobs: [], paths: { APP_USER: ['publisher/listing-flow'] }, declaredIn: ['backend', 'APP_USER'] },
      ],
    });
    repository.list.mockResolvedValue([flagRow(), flagRow({ key: 'ops.manual-thing', source: 'MANUAL', surfaces: [] })]);

    const res = await request(app()).get('/api/v1/flags/registry').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.generatedBy).toBe('scripts/features-sync.ts');
    expect(res.body.data.features.map((f: { key: string }) => f.key)).toEqual(['console.dashboard', 'marketplace.instant-booking', 'ops.manual-thing']);
    expect(res.body.data.features[0].flag).toBeNull();
    expect(res.body.data.features[1].flag.key).toBe('marketplace.instant-booking');
    expect(res.body.data.features[1].paths).toEqual({ APP_USER: ['publisher/listing-flow'] });
    // A row the document does not know is still listed, from the row alone.
    expect(res.body.data.features[2]).toMatchObject({ key: 'ops.manual-thing', declaredIn: [], flag: { source: 'MANUAL' } });
    // G11-2: the same verdict `npm run features:check` prints, per surface.
    expect(typeof res.body.data.check.current).toBe('boolean');
    expect(res.body.data.check.surfaces.map((s: { surface: string }) => s.surface)).toEqual(['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND', 'WEBSITE']);
    for (const surface of res.body.data.check.surfaces) {
      expect(typeof surface.behind).toBe('boolean');
      expect(Array.isArray(surface.reasons)).toBe(true);
    }
    // Nothing is declared in this process, so the document's backend entry is behind and the verdict says which key.
    const backend = res.body.data.check.surfaces.find((s: { surface: string }) => s.surface === 'BACKEND');
    expect(backend.behind).toBe(true);
    expect(backend.reasons).toContain('marketplace.instant-booking is in the document but no longer in the code');
    expect(res.body.data.check.current).toBe(false);
  });

  it('G11-2: answers the admin their own flags across every surface at /flags/me, through the same evaluator', async () => {
    expect((await request(app()).get('/api/v1/flags/me')).status).toBe(401);
    expect((await request(app()).get('/api/v1/flags/me').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);

    const res = await request(app()).get('/api/v1/flags/me').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    // The console-only row /app/flags leaves out is here; every answer is { enabled, variant }.
    expect(res.body.data['system.roles']).toEqual({ enabled: true, variant: null });
    expect(res.body.data['campaigns.landing-pages']).toEqual({ enabled: true, variant: 'builder' });
    expect(res.body.data['marketplace.instant-booking']).toEqual({ enabled: false, variant: null });
    // The same bucket /app/flags would give this caller.
    expect(res.body.data['publisher.spot-insights']).toEqual({ enabled: bucketFor('publisher.spot-insights', 'admin-1') < 50, variant: null });
    // No legacy booleans: those are the shipped apps' shape.
    expect(res.body.data['instant-booking']).toBeUndefined();
    expect(Object.values(res.body.data).every((answer) => typeof answer === 'object')).toBe(true);
  });

  it('serves the change history for one flag, and 404s an unknown key', async () => {
    repository.changes.mockResolvedValue([{ id: 'chg-1', byUserId: 'admin-1' }]);
    const res = await request(app())
      .get('/api/v1/flags/marketplace.instant-booking/changes')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // E6: the actor is joined; unregistered port, the name is null.
    expect(res.body.data[0].byUser).toEqual({ id: 'admin-1', name: null });

    const missing = await request(app()).get('/api/v1/flags/nope.nope/changes').set('Authorization', `Bearer ${admin}`);
    expect(missing.status).toBe(404);
  });
});

/** Answer 144: the kill switch on a route. */
describe('requireFeature', () => {
  it('lets the request through when the flag is on for the caller, and answers 503 FEATURE_OFF { key } when it is off', async () => {
    const on = await request(app()).get('/api/v1/gated').set('Authorization', `Bearer ${publisher}`);
    expect(on.status).toBe(200);

    const off = await request(app()).get('/api/v1/gated-dark').set('Authorization', `Bearer ${publisher}`);
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe('FEATURE_OFF');
    expect(off.body.error.details).toEqual({ key: 'marketplace.instant-booking' });
  });

  it('evaluates the rollout on the token: roles from the token, city through the port', async () => {
    repository.listState.mockResolvedValue([state({ key: 'campaigns.landing-pages', rollout: { roles: ['ADMIN'], cities: ['Pune'] } })]);
    registerFlagSubjectCityPort(async (userId) => (userId === 'admin-1' ? 'pune' : 'Delhi'));
    expect((await request(app()).get('/api/v1/gated-auth').set('Authorization', `Bearer ${admin}`)).status).toBe(200);
    expect((await request(app()).get('/api/v1/gated-auth').set('Authorization', `Bearer ${publisher}`)).status).toBe(503);
    // Mounted without authenticate: no subject, no roles — a rollout by role is closed.
    expect((await request(app()).get('/api/v1/gated').set('Authorization', `Bearer ${admin}`)).status).toBe(503);
  });

  it('lets the request through when the state cannot be read — a flags-table hiccup is not a platform outage', async () => {
    repository.listState.mockRejectedValue(new Error('connection refused'));
    expect((await request(app()).get('/api/v1/gated')).status).toBe(200);
  });

  it('is named for the route inventory', () => {
    expect(requireFeature('campaigns.landing-pages').name).toBe('requireFeature(campaigns.landing-pages)');
  });

  /** G10: the conditional gate — a write that only sometimes asks for the feature. */
  it('requireFeatureWhen bites only when the predicate holds, and never reads the state otherwise', async () => {
    const plain = await request(app()).post('/api/v1/gated-when').send({ title: 'x' });
    expect(plain.status).toBe(200);
    expect(repository.listState).not.toHaveBeenCalled();

    const opted = await request(app()).post('/api/v1/gated-when').send({ instantBooking: true });
    expect(opted.status).toBe(503);
    expect(opted.body.error).toMatchObject({ code: 'FEATURE_OFF', details: { key: 'marketplace.instant-booking' } });
    expect(requireFeatureWhen('marketplace.instant-booking', () => true).name).toBe('requireFeatureWhen(marketplace.instant-booking)');
  });
});

/** E6: `byUser` on the history and on `lastChange`, through the port bootstrap fills. */
describe('who moved it', () => {
  it('joins the actor by name once the port is registered', async () => {
    registerFlagUserLabelPort(async (ids) => new Map(ids.map((id) => [id, { id, name: id === 'admin-1' ? 'Priya' : null }])));
    repository.changes.mockResolvedValue([{ id: 'chg-1', byUserId: 'admin-1' }, { id: 'chg-0', byUserId: 'ghost' }]);
    const history = await request(app())
      .get('/api/v1/flags/marketplace.instant-booking/changes')
      .set('Authorization', `Bearer ${admin}`);
    expect(history.body.data.map((c: { byUser: unknown }) => c.byUser)).toEqual([
      { id: 'admin-1', name: 'Priya' },
      { id: 'ghost', name: null },
    ]);

    repository.list.mockResolvedValue([
      flagRow({ changes: [{ id: 'chg-9', flagKey: 'marketplace.instant-booking', enabled: true, rolloutPercent: 10, byUserId: 'admin-1' }] }),
    ]);
    const list = await request(app()).get('/api/v1/flags').set('Authorization', `Bearer ${admin}`);
    expect(list.body.data[0].lastChange.byUser).toEqual({ id: 'admin-1', name: 'Priya' });

    const moved = await request(app())
      .patch('/api/v1/flags/marketplace.instant-booking')
      .set('Authorization', `Bearer ${admin}`)
      .send({ enabled: true });
    expect(moved.body.data.lastChange.byUser).toEqual({ id: 'admin-1', name: 'Priya' });
  });
});

/** G11-2: the one checker `npm run features:check` and `GET /flags/registry` share. */
describe('the registry check', () => {
  const entry = (over: Partial<RegistryEntry> & { key: string }): RegistryEntry => ({
    surfaces: ['BACKEND'],
    kind: 'FEATURE',
    owner: 'platform',
    launch: 'on',
    description: 'd',
    variants: [],
    aliases: [],
    routes: [],
    jobs: [],
    paths: {},
    declaredIn: ['backend'],
    ...over,
  });
  const doc = (features: RegistryEntry[]): RegistryDocument => ({ generatedBy: 'test', featureCount: features.length, features });

  it('is current when every surface reads the same on both sides, in any order', () => {
    const a = entry({ key: 'a.one', surfaces: ['BACKEND', 'CONSOLE'], routes: ['/api/v1/a', '/api/v1/b'], paths: { CONSOLE: ['a', 'b'] }, declaredIn: ['backend', 'CONSOLE'] });
    const b = entry({ key: 'b.two', surfaces: ['CONSOLE'], declaredIn: ['CONSOLE'], paths: { CONSOLE: ['b'] } });
    const committed = doc([a, b]);
    const fresh = doc([{ ...b }, { ...a, routes: ['/api/v1/b', '/api/v1/a'], paths: { CONSOLE: ['b', 'a'] } }]);
    const verdict = compareRegistryDocuments(committed, fresh);
    expect(verdict.current).toBe(true);
    expect(verdict.surfaces.map((s) => s.surface)).toEqual(['APP_USER', 'APP_AGENT', 'CONSOLE', 'BACKEND', 'WEBSITE']);
    expect(verdict.surfaces.every((s) => !s.behind && s.reasons.length === 0)).toBe(true);
  });

  it('names, per surface, what is new, what is gone and what changed', () => {
    const committed = doc([
      entry({ key: 'a.one', surfaces: ['BACKEND', 'CONSOLE'], routes: ['/api/v1/a'], paths: { CONSOLE: ['a'] }, declaredIn: ['backend', 'CONSOLE'] }),
      entry({ key: 'gone.key' }),
      entry({ key: 'c.only', surfaces: ['CONSOLE'], declaredIn: ['CONSOLE'], paths: { CONSOLE: ['c'] } }),
    ]);
    const fresh = doc([
      entry({ key: 'a.one', surfaces: ['BACKEND', 'CONSOLE'], routes: ['/api/v1/a', '/api/v1/a/new'], description: 'changed', paths: { CONSOLE: ['a', 'a/new'] }, declaredIn: ['backend', 'CONSOLE'] }),
      entry({ key: 'new.key', surfaces: ['BACKEND', 'APP_USER'] }),
      entry({ key: 'c.only', surfaces: ['CONSOLE'], declaredIn: ['CONSOLE'], paths: { CONSOLE: ['c'] }, launch: 'dark' }),
    ]);
    const verdict = compareRegistryDocuments(committed, fresh);
    const by = Object.fromEntries(verdict.surfaces.map((s) => [s.surface, s]));
    expect(verdict.current).toBe(false);
    expect(by['BACKEND']).toEqual({
      surface: 'BACKEND',
      behind: true,
      reasons: ['a.one differs (description, routes)', 'gone.key is in the document but no longer in the code', 'new.key is in the code but not in the document'],
    });
    expect(by['CONSOLE']).toEqual({ surface: 'CONSOLE', behind: true, reasons: ['a.one differs (paths)', 'c.only differs (launch)'] });
    // A backend-declared surface with no manifest paths: on the surface, so its arrival is news there too.
    expect(by['APP_USER']).toEqual({ surface: 'APP_USER', behind: true, reasons: ['new.key is in the code but not in the document'] });
    expect(by['APP_AGENT']).toEqual({ surface: 'APP_AGENT', behind: false, reasons: [] });
    expect(by['WEBSITE']).toEqual({ surface: 'WEBSITE', behind: false, reasons: [] });
  });

  it('marks a surface whose manifest is not on disk "not compared" and leaves the others intact', () => {
    // The backend checked out alone: the fresh fold has no CONSOLE paths, and the merged columns are not held against it.
    const committed = doc([entry({ key: 'a.one', surfaces: ['BACKEND', 'CONSOLE'], variants: ['x'], paths: { CONSOLE: ['a'] }, declaredIn: ['backend', 'CONSOLE'] })]);
    const fresh = doc([entry({ key: 'a.one', surfaces: ['BACKEND'], declaredIn: ['backend'] })]);
    const verdict = compareRegistryDocuments(committed, fresh, { missingSurfaces: ['CONSOLE'] });
    const by = Object.fromEntries(verdict.surfaces.map((s) => [s.surface, s]));
    expect(verdict.current).toBe(true);
    expect(by['CONSOLE']).toEqual({ surface: 'CONSOLE', behind: false, reasons: ['the CONSOLE manifest is not on disk; not compared'] });
    expect(by['BACKEND']).toEqual({ surface: 'BACKEND', behind: false, reasons: [] });
    // A manifest that is there but does not parse is behind: the sync could not run either.
    const broken = compareRegistryDocuments(committed, fresh, { invalid: [{ surface: 'CONSOLE', error: 'x.y is not <area>.<capability>' }] });
    expect(broken.current).toBe(false);
    expect(broken.surfaces.find((s) => s.surface === 'CONSOLE')).toEqual({ surface: 'CONSOLE', behind: true, reasons: ['the CONSOLE manifest could not be read: x.y is not <area>.<capability>'] });
  });

  it('is behind on every surface when the document is missing', () => {
    const verdict = compareRegistryDocuments(null, doc([entry({ key: 'a.one' })]));
    expect(verdict.current).toBe(false);
    expect(verdict.surfaces.every((s) => s.behind && s.reasons[0]?.includes('features:sync'))).toBe(true);
  });

  it('checkRegistry folds the declarations this process loaded against the manifests on disk', () => {
    const verdict = checkRegistry(null, [{ key: 'campaigns.landing-pages', surfaces: ['BACKEND'], owner: 'demand', kind: 'FEATURE', launch: 'on', description: 'd', variants: [], aliases: [], routes: [], jobs: [] }]);
    expect(verdict.current).toBe(false);
    expect(verdict.surfaces).toHaveLength(5);
  });
});

/**
 * L-B: the bulk write. One transaction across every key, each key written
 * exactly as PATCH /:key writes it (lastGoodState, the change row, the
 * port), the whole batch refused when one key is unknown or a variant is
 * not the key's, and a key already at the asked position skipped with no
 * change row.
 */
describe('the bulk write', () => {
  const rows: Record<string, ReturnType<typeof flagRow>> = {};
  const bulk = (body: object, token = admin) =>
    request(app()).post('/api/v1/flags/bulk').set('Authorization', `Bearer ${token}`).send(body);
  const rollback = (body: object, token = admin) =>
    request(app()).post('/api/v1/flags/bulk/rollback').set('Authorization', `Bearer ${token}`).send(body);

  beforeEach(() => {
    rows['marketplace.instant-booking'] = flagRow({ enabled: false });
    rows['campaigns.multi-market'] = flagRow({ key: 'campaigns.multi-market', enabled: false, rolloutPercent: 50, variants: ['default', 'unwarned'] });
    rows['publisher.spot-insights'] = flagRow({ key: 'publisher.spot-insights', enabled: true });
    repository.find.mockImplementation(async (key: string) => rows[key] ?? null);
  });

  it('applies the patch to two keys in one transaction and skips a third already at the asked position, with no change row for it', async () => {
    const listener = vi.fn();
    registerFlagChangePort(listener);

    const res = await bulk({
      keys: ['marketplace.instant-booking', 'campaigns.multi-market', 'publisher.spot-insights'],
      patch: { enabled: true },
      note: 'Diwali launch: everything on',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.updated.map((flag: { key: string }) => flag.key)).toEqual(['marketplace.instant-booking', 'campaigns.multi-market']);
    // The same FlagView PATCH /:key answers: every column, lastChange in place of the history.
    expect(res.body.data.updated[0]).toMatchObject({ enabled: true, aliases: ['instant-booking'], lastChange: { id: 'chg-b1', note: 'Diwali launch: everything on' } });
    expect(res.body.data.updated[0].changes).toBeUndefined();
    // Only the switch moved: the other fields stay, and the position before is lastGoodState.
    expect(res.body.data.updated[1]).toMatchObject({ enabled: true, rolloutPercent: 50, lastGoodState: { enabled: false, rolloutPercent: 50, variant: null, rollout: null } });
    expect(res.body.data.skipped).toEqual([{ key: 'publisher.spot-insights', reason: 'already at the asked position' }]);

    // One transaction, two writes, each shaped exactly as a single PATCH's.
    expect(repository.updateMany).toHaveBeenCalledTimes(1);
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.updateMany).toHaveBeenCalledWith([
      {
        key: 'marketplace.instant-booking',
        next: { enabled: true, rolloutPercent: 100, variant: null, rollout: null, lastGoodState: { enabled: false, rolloutPercent: 100, variant: null, rollout: null } },
        change: { byUserId: 'admin-1', note: 'Diwali launch: everything on', rollbackOfId: null },
      },
      {
        key: 'campaigns.multi-market',
        next: { enabled: true, rolloutPercent: 50, variant: null, rollout: null, lastGoodState: { enabled: false, rolloutPercent: 50, variant: null, rollout: null } },
        change: { byUserId: 'admin-1', note: 'Diwali launch: everything on', rollbackOfId: null },
      },
    ]);
    // The cache is dropped and the port fires once per key written — the silent FLAGS_CHANGED push, as a single write.
    expect(cache.invalidate).toHaveBeenCalledWith(FLAG_STATE_CACHE_KEY);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ flag: expect.objectContaining({ key: 'marketplace.instant-booking', enabled: true }), changeId: 'chg-b1', byUserId: 'admin-1', rollback: false }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ flag: expect.objectContaining({ key: 'campaigns.multi-market' }), changeId: 'chg-b2', rollback: false }));
  });

  it('audits one FEATURE_FLAG_CHANGED row per key written, with the diff, plus one FLAGS_BULK_UPDATED summary carrying the keys and the note', async () => {
    audit.auditDiff.mockImplementation(((before: { enabled: boolean }, after: { enabled: boolean }) => ({ enabled: { before: before.enabled, after: after.enabled } })) as never);
    await bulk({ keys: ['marketplace.instant-booking', 'campaigns.multi-market', 'publisher.spot-insights'], patch: { enabled: true }, note: 'Diwali launch: everything on' });

    const rowsWritten = audit.logActivity.mock.calls;
    expect(rowsWritten.filter(([, action]) => action === 'FEATURE_FLAG_CHANGED')).toHaveLength(2);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'FEATURE_FLAG_CHANGED',
      expect.objectContaining({
        module: 'feature-flags',
        targetType: 'FeatureFlag',
        targetId: 'marketplace.instant-booking',
        diff: { enabled: { before: false, after: true } },
        metadata: expect.objectContaining({ note: 'Diwali launch: everything on', bulk: true }),
      }),
    );
    expect(audit.logActivity).toHaveBeenCalledWith('admin-1', 'FEATURE_FLAG_CHANGED', expect.objectContaining({ targetId: 'campaigns.multi-market' }));
    // No row for the key that did not move.
    expect(audit.logActivity).not.toHaveBeenCalledWith('admin-1', 'FEATURE_FLAG_CHANGED', expect.objectContaining({ targetId: 'publisher.spot-insights' }));
    // The summary row: the whole move in one line an incident review can read.
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'FLAGS_BULK_UPDATED',
      expect.objectContaining({
        module: 'feature-flags',
        targetType: 'FeatureFlag',
        metadata: {
          note: 'Diwali launch: everything on',
          patch: { enabled: true },
          keys: ['marketplace.instant-booking', 'campaigns.multi-market', 'publisher.spot-insights'],
          updated: ['marketplace.instant-booking', 'campaigns.multi-market'],
          skipped: [{ key: 'publisher.spot-insights', reason: 'already at the asked position' }],
        },
      }),
    );
    expect(rowsWritten).toHaveLength(3);
  });

  it('refuses the whole batch with a 404 naming the unknown keys, and writes nothing', async () => {
    const res = await bulk({ keys: ['marketplace.instant-booking', 'nope.nope', 'also.missing'], patch: { enabled: true }, note: 'Diwali launch' });
    expect(res.status).toBe(404);
    expect(res.body.error.details).toEqual({ keys: ['nope.nope', 'also.missing'] });
    expect(repository.updateMany).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('refuses the whole batch with a 400 naming the key whose variants do not include the asked variant, and writes nothing', async () => {
    const res = await bulk({ keys: ['campaigns.multi-market', 'marketplace.instant-booking'], patch: { variant: 'unwarned' }, note: 'Try the unwarned flow' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ variant: 'unwarned', keys: [{ key: 'marketplace.instant-booking', variants: [] }] });
    expect(repository.updateMany).not.toHaveBeenCalled();

    // The variant every key carries goes through; null clears it everywhere.
    rows['marketplace.instant-booking'] = flagRow({ variants: ['default', 'unwarned'], variant: 'default' });
    const ok = await bulk({ keys: ['campaigns.multi-market', 'marketplace.instant-booking'], patch: { variant: 'unwarned' }, note: 'Try the unwarned flow' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.updated).toHaveLength(2);
    expect(repository.updateMany.mock.calls[0]![0].map((write: { next: { variant: string } }) => write.next.variant)).toEqual(['unwarned', 'unwarned']);
  });

  it('refuses a missing or short note, a repeated key, an empty list, a patch naming nothing, and a caller below ADMIN', async () => {
    expect((await bulk({ keys: ['marketplace.instant-booking'], patch: { enabled: true } })).status).toBe(400);
    expect((await bulk({ keys: ['marketplace.instant-booking'], patch: { enabled: true }, note: 'ok' })).status).toBe(400);
    expect((await bulk({ keys: ['marketplace.instant-booking', 'marketplace.instant-booking'], patch: { enabled: true }, note: 'twice over' })).status).toBe(400);
    expect((await bulk({ keys: [], patch: { enabled: true }, note: 'nothing named' })).status).toBe(400);
    expect((await bulk({ keys: ['marketplace.instant-booking'], patch: {}, note: 'nothing to do' })).status).toBe(400);
    expect((await bulk({ keys: ['marketplace.instant-booking'], patch: { enabled: true }, note: 'not an admin' }, publisher)).status).toBe(403);
    expect(repository.updateMany).not.toHaveBeenCalled();
  });

  it('resolves a legacy alias to its registry key and, when the alias and the key are both named, writes the flag once', async () => {
    const res = await bulk({ keys: ['instant-booking', 'marketplace.instant-booking'], patch: { enabled: true }, note: 'Alias and key together' });
    expect(res.status).toBe(200);
    expect(res.body.data.updated.map((flag: { key: string }) => flag.key)).toEqual(['marketplace.instant-booking']);
    expect(res.body.data.skipped).toEqual([{ key: 'marketplace.instant-booking', reason: 'the same flag as instant-booking' }]);
  });

  it('skips a key whose rollout is already the one asked for, whatever the order of the lists', async () => {
    rows['marketplace.instant-booking'] = flagRow({ enabled: true, rollout: { roles: ['PUBLISHER', 'ADVERTISER'], cities: ['Pune'] } });
    const res = await bulk({ keys: ['marketplace.instant-booking'], patch: { rollout: { cities: ['Pune'], roles: ['ADVERTISER', 'PUBLISHER', 'PUBLISHER'] } }, note: 'No-op rollout' });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toEqual([]);
    expect(res.body.data.skipped).toEqual([{ key: 'marketplace.instant-booking', reason: 'already at the asked position' }]);
    expect(repository.updateMany).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledTimes(1);
    expect(audit.logActivity).toHaveBeenCalledWith('admin-1', 'FLAGS_BULK_UPDATED', expect.objectContaining({ metadata: expect.objectContaining({ updated: [] }) }));
  });

  describe('the bulk rollback', () => {
    beforeEach(() => {
      rows['marketplace.instant-booking'] = flagRow({ enabled: true, rolloutPercent: 10, lastGoodState: { enabled: false, rolloutPercent: 100, variant: null, rollout: null } });
      rows['campaigns.multi-market'] = flagRow({ key: 'campaigns.multi-market', enabled: true, variants: ['default', 'unwarned'], variant: 'unwarned', lastGoodState: { enabled: true, rolloutPercent: 100, variant: 'default', rollout: null } });
      // Never moved: nothing to roll back to.
      rows['publisher.spot-insights'] = flagRow({ key: 'publisher.spot-insights', enabled: true, lastGoodState: null });
      repository.changes.mockImplementation(async (key: string) => [{ id: `last-${key}`, byUserId: 'admin-1' }]);
    });

    it('rolls each key back to its lastGoodState through the rollback path, in one transaction, and skips a key that has never moved', async () => {
      const listener = vi.fn();
      registerFlagChangePort(listener);

      const res = await rollback({ keys: ['marketplace.instant-booking', 'campaigns.multi-market', 'publisher.spot-insights'], note: 'Checkout broke after the launch' });
      expect(res.status).toBe(200);
      expect(res.body.data.updated.map((flag: { key: string }) => flag.key)).toEqual(['marketplace.instant-booking', 'campaigns.multi-market']);
      expect(res.body.data.updated[0]).toMatchObject({ enabled: false, rolloutPercent: 100, lastChange: { rollbackOfId: 'last-marketplace.instant-booking' } });
      expect(res.body.data.updated[1]).toMatchObject({ variant: 'default', lastChange: { rollbackOfId: 'last-campaigns.multi-market' } });
      expect(res.body.data.skipped).toEqual([{ key: 'publisher.spot-insights', reason: 'this flag has not been moved since it was registered, so there is nothing to roll back to' }]);

      expect(repository.updateMany).toHaveBeenCalledTimes(1);
      expect(repository.updateMany).toHaveBeenCalledWith([
        {
          key: 'marketplace.instant-booking',
          // Restored, with the position rolled back from kept as the new lastGoodState so the rollback can itself be rolled back.
          next: { enabled: false, rolloutPercent: 100, variant: null, rollout: null, lastGoodState: { enabled: true, rolloutPercent: 10, variant: null, rollout: null } },
          change: { byUserId: 'admin-1', note: 'Checkout broke after the launch', rollbackOfId: 'last-marketplace.instant-booking' },
        },
        {
          key: 'campaigns.multi-market',
          next: { enabled: true, rolloutPercent: 100, variant: 'default', rollout: null, lastGoodState: { enabled: true, rolloutPercent: 100, variant: 'unwarned', rollout: null } },
          change: { byUserId: 'admin-1', note: 'Checkout broke after the launch', rollbackOfId: 'last-campaigns.multi-market' },
        },
      ]);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ flag: expect.objectContaining({ key: 'marketplace.instant-booking' }), rollback: true }));

      // One FEATURE_FLAG_ROLLED_BACK per key restored, plus the summary.
      expect(audit.logActivity).toHaveBeenCalledWith(
        'admin-1',
        'FEATURE_FLAG_ROLLED_BACK',
        expect.objectContaining({
          targetType: 'FeatureFlag',
          targetId: 'marketplace.instant-booking',
          metadata: expect.objectContaining({ restored: { enabled: false, rolloutPercent: 100, variant: null, rollout: null }, rollbackOfId: 'last-marketplace.instant-booking', note: 'Checkout broke after the launch', bulk: true }),
        }),
      );
      expect(audit.logActivity).toHaveBeenCalledWith('admin-1', 'FEATURE_FLAG_ROLLED_BACK', expect.objectContaining({ targetId: 'campaigns.multi-market' }));
      expect(audit.logActivity).toHaveBeenCalledWith(
        'admin-1',
        'FLAGS_BULK_ROLLED_BACK',
        expect.objectContaining({
          module: 'feature-flags',
          metadata: {
            note: 'Checkout broke after the launch',
            keys: ['marketplace.instant-booking', 'campaigns.multi-market', 'publisher.spot-insights'],
            updated: ['marketplace.instant-booking', 'campaigns.multi-market'],
            skipped: [{ key: 'publisher.spot-insights', reason: 'this flag has not been moved since it was registered, so there is nothing to roll back to' }],
          },
        }),
      );
      expect(audit.logActivity).toHaveBeenCalledTimes(3);
    });

    it('needs system.flags like /:key/rollback, a note, and refuses the batch on an unknown key with nothing written', async () => {
      const denied = await rollback({ keys: ['marketplace.instant-booking'], note: 'Checkout broke' }, adminWithoutRollback);
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.missing).toEqual(['system.flags']);

      expect((await rollback({ keys: ['marketplace.instant-booking'] })).status).toBe(400);

      const missing = await rollback({ keys: ['marketplace.instant-booking', 'nope.nope'], note: 'Checkout broke' });
      expect(missing.status).toBe(404);
      expect(missing.body.error.details).toEqual({ keys: ['nope.nope'] });
      expect(repository.updateMany).not.toHaveBeenCalled();
      expect(audit.logActivity).not.toHaveBeenCalled();
    });
  });
});

/**
 * L-B: the list, filtered server-side with the console's own filters so a
 * bulk selection can name "every key the filter leaves", and paged on
 * request. Without a parameter the bare array the console reads today.
 */
describe('the filtered and paged list', () => {
  const list = (query: string) => request(app()).get(`/api/v1/flags${query}`).set('Authorization', `Bearer ${admin}`);
  const moved = { id: 'chg-9', flagKey: 'x', enabled: false, rolloutPercent: 100, byUserId: 'admin-1' };

  beforeEach(() => {
    repository.list.mockResolvedValue([
      // Registered, on: ON.
      flagRow({ key: 'campaigns.landing-pages', enabled: true, kind: 'FEATURE', owner: 'demand', surfaces: ['APP_USER', 'CONSOLE', 'BACKEND'], description: 'The landing page builder' }),
      // Registered, off, never moved: a dark launch, not a kill.
      flagRow({ key: 'marketplace.instant-booking', enabled: false, kind: 'FEATURE', owner: 'marketplace', surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'] }),
      // Registered, off, moved: somebody threw the switch — OFF.
      flagRow({ key: 'comms.push', enabled: false, kind: 'KILL_SWITCH', owner: 'platform', surfaces: ['APP_USER', 'APP_AGENT', 'BACKEND'], changes: [{ ...moved, flagKey: 'comms.push' }] }),
      // Manual, off, never moved: not a dark launch — a MANUAL row has no launch.
      flagRow({ key: 'ops.manual-thing', enabled: false, source: 'MANUAL', kind: 'EXPERIMENT', owner: null, surfaces: ['CONSOLE'], description: 'Hand-made' }),
      flagRow({ key: 'system.roles', enabled: true, kind: 'FEATURE', owner: 'Platform', surfaces: ['CONSOLE'], description: 'Roles and permissions' }),
    ]);
  });

  it('answers the bare array, unchanged, when no parameter is given', async () => {
    const res = await list('');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.map((flag: { key: string }) => flag.key)).toEqual(['campaigns.landing-pages', 'marketplace.instant-booking', 'comms.push', 'ops.manual-thing', 'system.roles']);
    expect(res.body.data[0].lastChange).toBeNull();
  });

  it("filters by surface, kind, source, state, owner and q — the console's own rules, server-side", async () => {
    const keys = async (query: string) => {
      const res = await list(query);
      expect(res.status).toBe(200);
      return res.body.data.map((flag: { key: string }) => flag.key);
    };
    expect(await keys('?surface=CONSOLE')).toEqual(['campaigns.landing-pages', 'ops.manual-thing', 'system.roles']);
    expect(await keys('?kind=KILL_SWITCH')).toEqual(['comms.push']);
    expect(await keys('?source=MANUAL')).toEqual(['ops.manual-thing']);
    expect(await keys('?state=ON')).toEqual(['campaigns.landing-pages', 'system.roles']);
    // OFF is a switch somebody threw (or a manual row that is off); DARK_LAUNCH is a registered row that launched dark and never moved.
    expect(await keys('?state=OFF')).toEqual(['comms.push', 'ops.manual-thing']);
    expect(await keys('?state=DARK_LAUNCH')).toEqual(['marketplace.instant-booking']);
    expect(await keys('?owner=platform')).toEqual(['comms.push', 'system.roles']);
    // q is a substring over key, description, owner and aliases, case-insensitively.
    expect(await keys('?q=LANDING')).toEqual(['campaigns.landing-pages']);
    expect(await keys('?q=instant-booking')).toEqual(['marketplace.instant-booking']);
    expect(await keys('?q=hand-made')).toEqual(['ops.manual-thing']);
    // The filters AND.
    expect(await keys('?surface=APP_USER&state=OFF')).toEqual(['comms.push']);
    expect(await keys('?surface=WEBSITE')).toEqual([]);
  });

  it('refuses a surface, kind, source or state outside the vocabulary', async () => {
    expect((await list('?surface=PHONE')).status).toBe(400);
    expect((await list('?kind=TOGGLE')).status).toBe(400);
    expect((await list('?source=IMPORTED')).status).toBe(400);
    expect((await list('?state=MAYBE')).status).toBe(400);
    expect((await list('?page=0&pageSize=10')).status).toBe(400);
  });

  it('answers the list contract — items, total, page, pageSize and the three count facets — when page and pageSize are given', async () => {
    const res = await list('?page=2&pageSize=2');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(res.body.data.items.map((flag: { key: string }) => flag.key)).toEqual(['comms.push', 'ops.manual-thing']);
    expect(res.body.data.items[0].lastChange.id).toBe('chg-9');
    expect(res.body.data.counts).toEqual({
      surface: { APP_USER: 3, APP_AGENT: 2, CONSOLE: 3, BACKEND: 3, WEBSITE: 0 },
      kind: { FEATURE: 3, KILL_SWITCH: 1, EXPERIMENT: 1 },
      state: { ON: 2, OFF: 2, DARK_LAUNCH: 1 },
    });

    // The counts follow the filter with their own facet removed, so a chip row stays a way back out.
    const filtered = await list('?state=ON&surface=CONSOLE&page=1&pageSize=20');
    expect(filtered.body.data.total).toBe(2);
    expect(filtered.body.data.items.map((flag: { key: string }) => flag.key)).toEqual(['campaigns.landing-pages', 'system.roles']);
    expect(filtered.body.data.counts.state).toEqual({ ON: 2, OFF: 1, DARK_LAUNCH: 0 });
    expect(filtered.body.data.counts.surface).toEqual({ APP_USER: 1, APP_AGENT: 0, CONSOLE: 2, BACKEND: 1, WEBSITE: 0 });
    expect(filtered.body.data.counts.kind).toEqual({ FEATURE: 2, KILL_SWITCH: 0, EXPERIMENT: 0 });

    // A page past the end is empty, not an error; a filter alone still answers the bare array.
    expect((await list('?page=9&pageSize=2')).body.data.items).toEqual([]);
    expect(Array.isArray((await list('?state=ON')).body.data)).toBe(true);
  });
});
