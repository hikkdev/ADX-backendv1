import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsRepository } from '../ops.repository';

/**
 * Lot G (Q130): the incident log (ADMIN, under /settings/system-health),
 * the public status page (root-mounted, no token) and the region read.
 *
 * Pinned: every incident change is audited INCIDENT_*, tells every admin
 * in-app and mails every confirmed subscriber with their own unsubscribe
 * link; RESOLVED stamps `resolvedAt`; the public page derives each
 * service's state from the newest sample, the thresholds and the open
 * incidents, and carries no probe detail; subscribing sends a confirmation
 * to a new address only and answers the same either way; confirm and
 * unsubscribe are pages.
 */
const { repository, appConfig, notifications, users, audit, security } = vi.hoisted(() => ({
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
  appConfig: { getConfigObject: vi.fn(), getPlatformSettings: vi.fn() },
  notifications: { notify: vi.fn(), createNotification: vi.fn() },
  users: { listAdminUserIds: vi.fn(), systemUserId: vi.fn() },
  audit: { logActivity: vi.fn() },
  security: {
    statusPageLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
    statusSubscribeLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));

vi.mock('../prisma-ops.repository', () => ({ prismaOpsRepository: repository }));
vi.mock('../../app-config', () => appConfig);
vi.mock('../../notifications', () => notifications);
vi.mock('../../users', () => users);
vi.mock('../../../shared/storage', () => ({ listPrivateFiles: vi.fn(), probeStorage: vi.fn() }));
vi.mock('../../../shared/security', () => security);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { env } from '../../../config/env';
import type { HealthSample, HealthService } from '../../../shared/database';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { opsRouter, statusRouter } from '../ops.routes';
import { deriveServiceStates, errorRatePctOf, regions } from '../status.service';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(statusRouter);
  const api = Router();
  api.use('/settings/system-health', opsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const NOW = new Date('2026-09-14T03:00:00Z');
let admin = '';
let agent = '';
let incidents: Record<string, Record<string, unknown>>;
let seq = 0;

const thresholds = { apiP95DegradedMs: 1500, sampleStaleMinutes: 15 };
const sample = (service: HealthService, over: Partial<HealthSample> = {}): HealthSample => ({ id: `s-${service}`, service, ok: true, latencyMs: 10, detail: 'secret host detail', at: new Date(NOW.getTime() - 60_000), ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  admin = tokenFor(['ADMIN'], 'adm-1');
  agent = tokenFor(['AGENT_PUBLISHER'], 'agt-1');
  incidents = {};
  seq = 0;
  appConfig.getPlatformSettings.mockResolvedValue({ health: thresholds });
  users.listAdminUserIds.mockResolvedValue(['adm-1', 'adm-2']);
  notifications.createNotification.mockResolvedValue({ id: 'n-1' });
  notifications.notify.mockResolvedValue({ notificationId: null, templateKey: 'incident-update', deliveries: [{ channel: 'EMAIL', deliveryId: 'd-1' }] });
  repository.confirmedSubscribers.mockResolvedValue([{ email: 'a@x.io', token: 'tok-a' }, { email: 'b@x.io', token: 'tok-b' }]);
  repository.createIncident.mockImplementation(async (data: Record<string, unknown>, first: Record<string, unknown>) => {
    const id = `inc-${++seq}`;
    incidents[id] = { id, ...data, status: first['status'], resolvedAt: null, createdAt: NOW, updatedAt: NOW, updates: [{ id: 'u-1', incidentId: id, ...first }] };
    return incidents[id];
  });
  repository.findIncident.mockImplementation(async (id: string) => incidents[id] ?? null);
  repository.addUpdate.mockImplementation(async (id: string, update: Record<string, unknown>, patch: Record<string, unknown>) => {
    const current = incidents[id]!;
    incidents[id] = { ...current, ...patch, updates: [...(current['updates'] as unknown[]), { id: `u-${++seq}`, incidentId: id, ...update }] };
    return incidents[id];
  });
  repository.patchIncident.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
    incidents[id] = { ...incidents[id], ...patch };
    return incidents[id];
  });
  repository.latestSamples.mockResolvedValue([]);
  repository.openIncidents.mockResolvedValue([]);
});

afterEach(() => vi.useRealTimers());

describe('incidents', () => {
  it('is ADMIN-only', async () => {
    await request(app()).get('/api/v1/settings/system-health/incidents').expect(401);
    await request(app()).post('/api/v1/settings/system-health/incidents').set('Authorization', `Bearer ${agent}`).send({}).expect(403);
  });

  it('opens an incident with its first update, audits, tells the admins and mails the subscribers', async () => {
    const res = await request(app())
      .post('/api/v1/settings/system-health/incidents')
      .set('Authorization', `Bearer ${admin}`)
      .send({ title: 'Storage slow', severity: 'MAJOR', services: ['STORAGE'], body: 'Uploads are taking longer than usual.' })
      .expect(201);

    expect(res.body.data).toMatchObject({ id: 'inc-1', title: 'Storage slow', severity: 'MAJOR', status: 'OPEN', services: ['STORAGE'], createdById: 'adm-1' });
    expect(res.body.data.updates).toEqual([expect.objectContaining({ status: 'OPEN', body: 'Uploads are taking longer than usual.', byUserId: 'adm-1' })]);
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'INCIDENT_CREATED', expect.objectContaining({ module: 'ops', targetType: 'Incident', targetId: 'inc-1', diff: expect.objectContaining({ severity: { before: null, after: 'MAJOR' } }) }));
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'adm-2', type: 'SYSTEM', title: 'Incident open: Storage slow', relatedId: 'inc-1' }));
    expect(notifications.notify).toHaveBeenCalledTimes(2);
    expect(notifications.notify).toHaveBeenCalledWith(
      'INCIDENT_UPDATE',
      null,
      { title: 'Storage slow', status: 'OPEN', severity: 'MAJOR', services: 'STORAGE', body: 'Uploads are taking longer than usual.', unsubscribeUrl: expect.stringMatching(/\/status\/unsubscribe\/tok-b$/) },
      { recipient: { email: 'b@x.io' }, type: 'SYSTEM' },
    );
  });

  it('an update moves the status; RESOLVED stamps resolvedAt and audits INCIDENT_RESOLVED', async () => {
    await request(app()).post('/api/v1/settings/system-health/incidents').set('Authorization', `Bearer ${admin}`).send({ title: 'API errors', severity: 'CRITICAL', services: ['API'], body: 'Elevated 5xx.' }).expect(201);
    vi.clearAllMocks();
    users.listAdminUserIds.mockResolvedValue(['adm-1']);
    repository.confirmedSubscribers.mockResolvedValue([]);

    const monitoring = await request(app()).post('/api/v1/settings/system-health/incidents/inc-1/updates').set('Authorization', `Bearer ${admin}`).send({ status: 'MONITORING', body: 'A fix is deployed; watching.' }).expect(201);
    expect(monitoring.body.data).toMatchObject({ status: 'MONITORING', resolvedAt: null });
    expect(monitoring.body.data.updates).toHaveLength(2);
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'INCIDENT_UPDATED', expect.objectContaining({ targetId: 'inc-1', diff: expect.objectContaining({ status: { before: 'OPEN', after: 'MONITORING' } }) }));

    const resolved = await request(app()).post('/api/v1/settings/system-health/incidents/inc-1/updates').set('Authorization', `Bearer ${admin}`).send({ status: 'RESOLVED', body: 'Error rate back to normal.' }).expect(201);
    expect(resolved.body.data.status).toBe('RESOLVED');
    expect(new Date(resolved.body.data.resolvedAt).toISOString()).toBe(NOW.toISOString());
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'INCIDENT_RESOLVED', expect.objectContaining({ targetId: 'inc-1' }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Incident resolved: API errors' }));

    await request(app()).post('/api/v1/settings/system-health/incidents/inc-1/updates').set('Authorization', `Bearer ${admin}`).send({ status: 'CLOSED', body: 'x' }).expect(400);
    await request(app()).post('/api/v1/settings/system-health/incidents/nope/updates').set('Authorization', `Bearer ${admin}`).send({ status: 'OPEN', body: 'hello there' }).expect(404);
  });

  it('PATCH edits or resolves with a closing note, each audited', async () => {
    await request(app()).post('/api/v1/settings/system-health/incidents').set('Authorization', `Bearer ${admin}`).send({ title: 'Redis blip', body: 'Short reconnect storm.' }).expect(201);
    vi.clearAllMocks();
    users.listAdminUserIds.mockResolvedValue(['adm-1']);
    repository.confirmedSubscribers.mockResolvedValue([]);

    const edited = await request(app()).patch('/api/v1/settings/system-health/incidents/inc-1').set('Authorization', `Bearer ${admin}`).send({ services: ['REDIS'], title: 'Redis reconnects' }).expect(200);
    expect(edited.body.data).toMatchObject({ title: 'Redis reconnects', services: ['REDIS'], status: 'OPEN' });
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'INCIDENT_EDITED', expect.objectContaining({ targetId: 'inc-1' }));
    expect(notifications.createNotification).not.toHaveBeenCalled();

    const resolved = await request(app()).patch('/api/v1/settings/system-health/incidents/inc-1').set('Authorization', `Bearer ${admin}`).send({ status: 'RESOLVED', body: 'Stable for an hour.' }).expect(200);
    expect(resolved.body.data).toMatchObject({ status: 'RESOLVED' });
    expect(resolved.body.data.updates.at(-1)).toMatchObject({ status: 'RESOLVED', body: 'Stable for an hour.' });
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'INCIDENT_RESOLVED', expect.objectContaining({ targetId: 'inc-1' }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Incident resolved: Redis reconnects' }));

    await request(app()).patch('/api/v1/settings/system-health/incidents/inc-1').set('Authorization', `Bearer ${admin}`).send({}).expect(400);
    await request(app()).patch('/api/v1/settings/system-health/incidents/inc-1').set('Authorization', `Bearer ${admin}`).send({ status: 'OPEN' }).expect(400);
  });

  it('lists on the list contract', async () => {
    repository.listIncidents.mockResolvedValue({ items: [], total: 0, counts: { OPEN: 0, MONITORING: 0, RESOLVED: 0 } });
    const res = await request(app()).get('/api/v1/settings/system-health/incidents?status=OPEN,MONITORING&service=API&q=api').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(repository.listIncidents).toHaveBeenCalledWith({ q: 'api', status: ['OPEN', 'MONITORING'], service: 'API' }, expect.objectContaining({ page: 1, pageSize: 20, sort: 'newest' }));
    expect(res.body.data).toEqual({ items: [], total: 0, page: 1, pageSize: 20, counts: { OPEN: 0, MONITORING: 0, RESOLVED: 0 } });
  });
});

describe('deriveServiceStates', () => {
  it('reads the newest sample against the thresholds and the open incidents', () => {
    const states = deriveServiceStates(
      [
        sample('API', { latencyMs: 2100 }),
        sample('POSTGRES', { ok: false }),
        sample('REDIS', { at: new Date(NOW.getTime() - 20 * 60_000) }),
        sample('STORAGE'),
      ],
      [{ severity: 'MINOR', services: ['STORAGE'] }],
      thresholds,
      NOW,
    );
    expect(states).toEqual([
      { service: 'API', status: 'DEGRADED', latencyMs: 2100, sampledAt: sample('API').at.toISOString() },
      { service: 'POSTGRES', status: 'OUTAGE', latencyMs: 10, sampledAt: expect.any(String) },
      { service: 'REDIS', status: 'UNKNOWN', latencyMs: 10, sampledAt: expect.any(String) },
      { service: 'STORAGE', status: 'DEGRADED', latencyMs: 10, sampledAt: expect.any(String) },
      { service: 'JOBS', status: 'UNKNOWN', latencyMs: null, sampledAt: null },
    ]);
  });

  it('a CRITICAL incident is an outage whatever the probe says, and a passing probe never lowers an incident', () => {
    const states = deriveServiceStates([sample('API'), sample('JOBS', { latencyMs: null })], [{ severity: 'CRITICAL', services: ['API', 'JOBS'] }], thresholds, NOW);
    expect(states.map((s) => s.status)).toEqual(['OUTAGE', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'OUTAGE']);
  });
});

describe('GET /status', () => {
  it('is public, names the region, the services and the open incidents, and carries no probe detail', async () => {
    repository.latestSamples.mockResolvedValue([sample('API'), sample('POSTGRES'), sample('REDIS'), sample('STORAGE'), sample('JOBS', { latencyMs: null })]);
    repository.openIncidents.mockResolvedValue([
      { id: 'inc-7', title: 'Slow uploads', severity: 'MINOR', status: 'MONITORING', services: ['STORAGE'], body: 'x', startedAt: NOW, resolvedAt: null, createdById: 'adm-1', createdAt: NOW, updatedAt: NOW, updates: [{ id: 'u', incidentId: 'inc-7', status: 'OPEN', body: 'Investigating.', byUserId: 'adm-1', at: NOW }] },
    ]);
    const res = await request(app()).get('/status').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ region: env.APP_REGION, overall: 'DEGRADED', generatedAt: NOW.toISOString() });
    expect(res.body.data.services).toEqual([
      { service: 'API', status: 'OPERATIONAL', latencyMs: 10, sampledAt: expect.any(String) },
      { service: 'POSTGRES', status: 'OPERATIONAL', latencyMs: 10, sampledAt: expect.any(String) },
      { service: 'REDIS', status: 'OPERATIONAL', latencyMs: 10, sampledAt: expect.any(String) },
      { service: 'STORAGE', status: 'DEGRADED', latencyMs: 10, sampledAt: expect.any(String) },
      { service: 'JOBS', status: 'OPERATIONAL', latencyMs: null, sampledAt: expect.any(String) },
    ]);
    expect(res.body.data.incidents).toEqual([{ id: 'inc-7', title: 'Slow uploads', severity: 'MINOR', status: 'MONITORING', services: ['STORAGE'], startedAt: NOW.toISOString(), updates: [{ status: 'OPEN', body: 'Investigating.', at: NOW.toISOString() }] }]);
    expect(JSON.stringify(res.body)).not.toContain('secret host detail');
    expect(JSON.stringify(res.body)).not.toContain('adm-1');
  });

  it('is UNKNOWN across the board before the first sample', async () => {
    const res = await request(app()).get('/status').expect(200);
    expect(res.body.data.overall).toBe('UNKNOWN');
    expect(res.body.data.services.every((s: { status: string }) => s.status === 'UNKNOWN')).toBe(true);
  });
});

describe('subscribing', () => {
  it('sends a confirmation to a new address, in the request, with the confirm link', async () => {
    repository.upsertSubscriber.mockResolvedValue({ id: 'sub-1', email: 'new@x.io', token: 'tok-new-0001', confirmedAt: null, createdAt: NOW });
    const res = await request(app()).post('/status/subscribe').send({ email: ' New@X.io ' }).expect(202);
    expect(repository.upsertSubscriber).toHaveBeenCalledWith('new@x.io', expect.stringMatching(/^[A-Za-z0-9_-]{32}$/));
    expect(notifications.notify).toHaveBeenCalledWith('STATUS_SUBSCRIBE_CONFIRM', null, { confirmUrl: expect.stringMatching(/\/status\/confirm\/tok-new-0001$/) }, { recipient: { email: 'new@x.io' }, type: 'SYSTEM', immediate: true });
    expect(res.body.data.message).toContain('If this address is new');
  });

  it('sends nothing to an address already confirmed, and answers the same', async () => {
    repository.upsertSubscriber.mockResolvedValue({ id: 'sub-1', email: 'old@x.io', token: 'tok-old', confirmedAt: NOW, createdAt: NOW });
    const res = await request(app()).post('/status/subscribe').send({ email: 'old@x.io' }).expect(202);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(res.body.data.message).toContain('If this address is new');
    await request(app()).post('/status/subscribe').send({ email: 'not-an-email' }).expect(400);
  });

  it('confirm and unsubscribe are pages; a bad token is a 404', async () => {
    repository.findSubscriberByToken.mockResolvedValue({ id: 'sub-1', email: 'new@x.io', token: 'tok-new-0001', confirmedAt: null, createdAt: NOW });
    repository.confirmSubscriber.mockResolvedValue({});
    const confirmed = await request(app()).get('/status/confirm/tok-new-0001').expect(200);
    expect(confirmed.headers['content-type']).toContain('text/html');
    expect(confirmed.text).toContain('You are subscribed');
    expect(repository.confirmSubscriber).toHaveBeenCalledWith('sub-1', NOW);

    const gone = await request(app()).get('/status/unsubscribe/tok-new-0001').expect(200);
    expect(gone.text).toContain('You are unsubscribed');
    expect(repository.deleteSubscriber).toHaveBeenCalledWith('sub-1');

    repository.findSubscriberByToken.mockResolvedValue(null);
    await request(app()).get('/status/confirm/tok-unknown-0001').expect(404);
    await request(app()).get('/status/unsubscribe/tok-unknown-0001').expect(404);
  });
});

describe('regions', () => {
  const probes = {
    api: async () => ({ p95Ms: 140, count: 9 }),
    postgres: async () => ({ ok: true as const, latencyMs: 7 }),
    redis: async () => ({ ok: false as const, error: 'down' }),
    storage: async () => ({ ok: true as const, provider: 'local' as const, latencyMs: 1 }),
    heartbeats: async () => [],
  };

  it('names the one region with a live round trip to each store', async () => {
    repository.latestIncidentAt.mockResolvedValue(null);
    const out = await regions(NOW, probes, async () => ({ requests: 0, serverErrors: 0, hours: 24 }));
    expect(out).toEqual({
      regions: [{ region: env.APP_REGION, current: true, latency: { postgresMs: 7, redisMs: null, apiP95Ms: 140 }, errorRatePct: null, lastIncidentAt: null, checkedAt: NOW.toISOString() }],
    });
  });

  it('G13-B: carries the 5xx share over the last 24 h and the newest incident touching its services', async () => {
    repository.latestIncidentAt.mockResolvedValue(new Date('2026-09-13T20:00:00Z'));
    const out = await regions(NOW, probes, async () => ({ requests: 4000, serverErrors: 9, hours: 24 }));
    expect(out.regions[0]).toMatchObject({ errorRatePct: 0.23, lastIncidentAt: '2026-09-13T20:00:00.000Z' });
    expect(repository.latestIncidentAt).toHaveBeenCalled();
    expect(errorRatePctOf({ requests: 3, serverErrors: 1 })).toBe(33.33);
    expect(errorRatePctOf({ requests: 0, serverErrors: 0 })).toBeNull();
  });

  it('G13-B: an unreadable counter or incident table answers null, never a failed read', async () => {
    repository.latestIncidentAt.mockRejectedValue(new Error('db down'));
    const out = await regions(NOW, probes, async () => {
      throw new Error('redis down');
    });
    expect(out.regions[0]).toMatchObject({ errorRatePct: null, lastIncidentAt: null, latency: { postgresMs: 7 } });
  });

  it('is served ADMIN-only at /settings/system-health/regions', async () => {
    await request(app()).get('/api/v1/settings/system-health/regions').set('Authorization', `Bearer ${agent}`).expect(403);
  });
});
