import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot K (B2): `POST /packages/quote` answers the term beside the money —
 * `{ rule, startsAt, endsAt, replaces, prorationAmount }` — for the
 * advertiser in the session, or for the advertiser an agent names with
 * `?advertiserId=` provided they hold that account (the same check `GET
 * /active` makes). An admin naming nobody gets `term: null`. Pinned at the
 * route with the real router over a mocked service, so the scope rule is
 * the thing under test.
 */

const { service, advertisers, agents, repository } = vi.hoisted(() => ({
  service: {
    quote: vi.fn(),
    listCatalogue: vi.fn(),
    activePackageWithOptions: vi.fn(),
  },
  advertisers: { getAdvertiserForUser: vi.fn(), assertNotSuspended: vi.fn(), payForPackage: vi.fn() },
  agents: { findAgentProfile: vi.fn() },
  repository: { advertiserContext: vi.fn() },
}));

vi.mock('../packages.service', () => service);
vi.mock('../prisma-packages.repository', () => ({ prismaPackagesRepository: repository }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../agents', () => agents);
vi.mock('../../../shared/security/rate-limit', () => ({
  packageLinkLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { packageRouter } from '../packages.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/packages', packageRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const advertiser = tokenFor(['ADVERTISER'], 'usr_adv');
const agent = tokenFor(['AGENT_ADVERTISER'], 'usr_agent');
const admin = tokenFor(['ADMIN'], 'usr_admin');
const NOW = new Date('2026-09-14T06:00:00.000Z');
const TERM = { rule: 'STARTS_NOW', startsAt: NOW, endsAt: new Date('2026-10-14T06:00:00.000Z'), replaces: null, prorationAmount: null };

beforeEach(() => {
  vi.clearAllMocks();
  advertisers.getAdvertiserForUser.mockImplementation(async (userId: string) => (userId === 'usr_adv' ? { id: 'adv_1' } : null));
  agents.findAgentProfile.mockImplementation(async (userId: string) => (userId === 'usr_agent' ? { id: 'agt_1' } : null));
  repository.advertiserContext.mockImplementation(async (id: string) => (id === 'adv_1' ? { id: 'adv_1', agentId: 'agt_1' } : id === 'adv_other' ? { id: 'adv_other', agentId: 'agt_9' } : null));
  service.quote.mockImplementation(async (input: { advertiserId?: string | null }) => ({
    priced: { total: '29498.82', cycle: 'MONTHLY' },
    plan: {},
    addOns: [],
    policy: { changePolicy: 'REPLACE_NOW' },
    term: input.advertiserId ? TERM : null,
  }));
});

describe('POST /packages/quote — the term', () => {
  it('quotes the advertiser in the session and answers their term beside the money and the policy', async () => {
    const res = await request(app()).post('/api/v1/packages/quote').set('Authorization', `Bearer ${advertiser}`).send({ tier: 'GROWTH', cycle: 'MONTHLY' });
    expect(res.status).toBe(200);
    expect(service.quote).toHaveBeenCalledWith(expect.objectContaining({ tier: 'GROWTH', cycle: 'MONTHLY', advertiserId: 'adv_1' }));
    expect(res.body.data).toMatchObject({ total: '29498.82', policy: { changePolicy: 'REPLACE_NOW' }, term: { rule: 'STARTS_NOW', startsAt: NOW.toISOString(), replaces: null, prorationAmount: null } });
  });

  it('an agent names the advertiser they hold with ?advertiserId= and gets that advertiser\'s term', async () => {
    const res = await request(app()).post('/api/v1/packages/quote?advertiserId=adv_1').set('Authorization', `Bearer ${agent}`).send({ tier: 'GROWTH' });
    expect(res.status).toBe(200);
    expect(repository.advertiserContext).toHaveBeenCalledWith('adv_1');
    expect(service.quote).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: 'adv_1' }));
    expect(res.body.data.term).toMatchObject({ rule: 'STARTS_NOW' });
  });

  it('an agent naming an advertiser they do not hold is refused 403 before anything is priced; an unknown advertiser is 404', async () => {
    const forbidden = await request(app()).post('/api/v1/packages/quote?advertiserId=adv_other').set('Authorization', `Bearer ${agent}`).send({ tier: 'GROWTH' });
    expect(forbidden.status).toBe(403);
    expect(service.quote).not.toHaveBeenCalled();

    const missing = await request(app()).post('/api/v1/packages/quote?advertiserId=adv_nope').set('Authorization', `Bearer ${agent}`).send({ tier: 'GROWTH' });
    expect(missing.status).toBe(404);
  });

  it('an agent naming nobody has no advertiser in scope: priced, term null', async () => {
    const res = await request(app()).post('/api/v1/packages/quote').set('Authorization', `Bearer ${agent}`).send({ tier: 'GROWTH' });
    expect(res.status).toBe(200);
    expect(service.quote).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: null }));
    expect(res.body.data.term).toBeNull();
  });

  it('an admin may name any advertiser, and naming nobody gets term null', async () => {
    const named = await request(app()).post('/api/v1/packages/quote?advertiserId=adv_other').set('Authorization', `Bearer ${admin}`).send({ tier: 'GROWTH' });
    expect(named.status).toBe(200);
    expect(service.quote).toHaveBeenLastCalledWith(expect.objectContaining({ advertiserId: 'adv_other' }));
    expect(repository.advertiserContext).not.toHaveBeenCalled();

    const nobody = await request(app()).post('/api/v1/packages/quote').set('Authorization', `Bearer ${admin}`).send({ tier: 'GROWTH' });
    expect(nobody.status).toBe(200);
    expect(nobody.body.data.term).toBeNull();
  });
});
