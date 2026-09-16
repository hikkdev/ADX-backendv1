import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-2 over HTTP: the approvals desk keeps its bare array until a page is
 * asked for, then answers the list contract with `source` and `listingId`
 * passed through; the dry run takes a draft grid and answers the impact
 * shape, ADMIN only.
 */

const service = vi.hoisted(() => ({
  listApprovals: vi.fn(),
  listApprovalsPage: vi.fn(),
  cardImpact: vi.fn(),
  cardImpactDryRun: vi.fn(),
  gateView: vi.fn(),
  assertMayAskGate: vi.fn(),
  requestApproval: vi.fn(),
}));

vi.mock('../rate-cards.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rate-cards.service')>()),
  ...service,
}));

import { ApiError, errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { rateCardRouter } from '../rate-cards.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/rate-cards', rateCardRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'usr_ops');
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');
const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');
const advertiser = tokenFor(['ADVERTISER'], 'usr_adv');

/** E11-1: the gate route's shape — the verdict, the badge, the numbers and the case. */
const gate = {
  state: 'AWAITING_APPROVAL',
  approvalId: 'pa_7',
  cardId: 'rc_4',
  cardRate: '10000.00',
  floor: '8200.00',
  rate: '5000.00',
  belowFloor: true,
  floorRatePerDay: '8200.00',
  shortfall: '3200.00',
  case: { id: 'pa_7', status: 'PENDING', source: 'CARD_REVISION', graceUntil: '2026-09-27T00:00:00.000Z', heldByRunningOrder: false },
};

const card = { id: 'rc_4', name: 'Bengaluru Metro Premium', version: 4, status: 'DRAFT', graceDays: 14 };
const impactRow = { listingId: 'lst_1', title: 'MG Road', ratePerDay: '7000.00', cardRate: '12000.00', floor: '10800.00', shortfall: '3800.00', liveCase: null };

beforeEach(() => {
  vi.clearAllMocks();
  service.listApprovals.mockResolvedValue([{ id: 'pa_1', status: 'PENDING', source: 'CARD_REVISION', heldByRunningOrder: false }]);
  service.listApprovalsPage.mockResolvedValue({ items: [{ id: 'pa_1' }], total: 1, page: 1, pageSize: 20, counts: { PENDING: 1, APPROVED: 0, REJECTED: 0 } });
  service.cardImpact.mockResolvedValue({ card, rows: [] });
  service.cardImpactDryRun.mockResolvedValue({ card: { ...card, graceDays: 30 }, rows: [impactRow] });
  service.gateView.mockResolvedValue(gate);
  service.assertMayAskGate.mockResolvedValue(undefined);
  service.requestApproval.mockResolvedValue({ id: 'pa_7' });
});

describe('GET /rate-cards/gate/:listingId', () => {
  const keys = ['state', 'belowFloor', 'floorRatePerDay', 'shortfall', 'case'];

  it('answers the party the verdict, the badge, the floor, the shortfall and the case', async () => {
    const res = await request(app()).get('/api/v1/rate-cards/gate/lst_1').set('Authorization', `Bearer ${publisher}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(gate);
    for (const key of keys) expect(res.body.data).toHaveProperty(key);
    expect(service.gateView).toHaveBeenCalledWith('lst_1');
    expect(service.assertMayAskGate).toHaveBeenCalledWith('lst_1', { userId: 'usr_pub', isAdmin: false });
  });

  /**
   * E11 verify: the case is the publisher's business. The route's role check
   * lets any publisher account through, so the handler asks the policy whether
   * this caller is the listing's publisher, their agent, or ADX — and a refusal
   * is the whole answer; the verdict is never read.
   */
  it("refuses a publisher who is not the listing's, before the verdict is read", async () => {
    service.assertMayAskGate.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'This is not your publisher.'));
    const res = await request(app()).get('/api/v1/rate-cards/gate/lst_1').set('Authorization', `Bearer ${publisher}`);
    expect(res.status).toBe(403);
    expect(service.gateView).not.toHaveBeenCalled();
  });

  it('asks the policy as ADMIN for ADX, and as the agent for an agent', async () => {
    await request(app()).get('/api/v1/rate-cards/gate/lst_1').set('Authorization', `Bearer ${admin}`);
    expect(service.assertMayAskGate).toHaveBeenLastCalledWith('lst_1', { userId: 'usr_ops', isAdmin: true });
    await request(app()).get('/api/v1/rate-cards/gate/lst_1').set('Authorization', `Bearer ${agent}`);
    expect(service.assertMayAskGate).toHaveBeenLastCalledWith('lst_1', { userId: 'usr_agent', isAdmin: false });
  });

  it('answers ADMIN and the agent the same shape', async () => {
    const asAdmin = await request(app()).get('/api/v1/rate-cards/gate/lst_1').set('Authorization', `Bearer ${admin}`);
    const asAgent = await request(app()).get('/api/v1/rate-cards/gate/lst_1').set('Authorization', `Bearer ${agent}`);
    expect(asAdmin.status).toBe(200);
    expect(asAgent.status).toBe(200);
    expect(asAdmin.body.data).toEqual(gate);
    expect(asAgent.body.data).toEqual(gate);
  });

  it('keeps the nulls where nothing is under the floor, and refuses an advertiser', async () => {
    service.gateView.mockResolvedValue({ state: 'NOT_COVERED', belowFloor: false, floorRatePerDay: null, shortfall: null, case: null });
    const res = await request(app()).get('/api/v1/rate-cards/gate/lst_1').set('Authorization', `Bearer ${publisher}`);
    expect(res.body.data).toEqual({ state: 'NOT_COVERED', belowFloor: false, floorRatePerDay: null, shortfall: null, case: null });
    expect((await request(app()).get('/api/v1/rate-cards/gate/lst_1').set('Authorization', `Bearer ${advertiser}`)).status).toBe(403);
  });
});

describe('POST /rate-cards/approvals', () => {
  /** The same door, one verb later: nobody opens a price case on somebody else's spot. */
  it('asks the policy before a case is opened, and refuses a stranger', async () => {
    const ok = await request(app()).post('/api/v1/rate-cards/approvals').set('Authorization', `Bearer ${publisher}`).send({ listingId: 'lst_1' });
    expect(ok.status).toBe(201);
    expect(service.assertMayAskGate).toHaveBeenCalledWith('lst_1', { userId: 'usr_pub', isAdmin: false });
    expect(service.requestApproval).toHaveBeenCalledWith('lst_1', 'usr_pub', undefined);

    service.assertMayAskGate.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'This is not your publisher.'));
    service.requestApproval.mockClear();
    const no = await request(app()).post('/api/v1/rate-cards/approvals').set('Authorization', `Bearer ${agent}`).send({ listingId: 'lst_1' });
    expect(no.status).toBe(403);
    expect(service.requestApproval).not.toHaveBeenCalled();
  });
});

describe('GET /rate-cards/approvals', () => {
  it('answers the bare array with source and listingId passed through when no page is asked for', async () => {
    const res = await request(app()).get('/api/v1/rate-cards/approvals?status=PENDING&source=CARD_REVISION&listingId=lst_1').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(service.listApprovals).toHaveBeenCalledWith({ status: 'PENDING', source: 'CARD_REVISION', listingId: 'lst_1' });
    expect(service.listApprovalsPage).not.toHaveBeenCalled();
  });

  it('answers the list contract when ?page= or ?pageSize= is sent', async () => {
    const res = await request(app()).get('/api/v1/rate-cards/approvals?source=PUBLISH_REQUEST&pageSize=10').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ items: [{ id: 'pa_1' }], total: 1, counts: { PENDING: 1 } });
    expect(service.listApprovalsPage).toHaveBeenCalledWith({ source: 'PUBLISH_REQUEST' }, { page: 1, pageSize: 10 });
    expect(service.listApprovals).not.toHaveBeenCalled();
  });

  it('refuses a source outside the vocabulary and a page size over the cap', async () => {
    expect((await request(app()).get('/api/v1/rate-cards/approvals?source=GUESS').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
    expect((await request(app()).get('/api/v1/rate-cards/approvals?pageSize=500').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
  });
});

describe('POST /rate-cards/:id/impact/dry-run', () => {
  it('takes a draft grid and answers the impact shape without persisting', async () => {
    const body = { entries: [{ mediaTypeId: 'mt_1', grade: 'A', ratePerDay: '12000.00' }], floorPct: '0.9', graceDays: 30 };
    const res = await request(app()).post('/api/v1/rate-cards/rc_4/impact/dry-run').set('Authorization', `Bearer ${admin}`).send(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cardId: 'rc_4', name: card.name, version: 4, status: 'DRAFT', graceDays: 30, affected: 1, rows: [impactRow] });
    expect(service.cardImpactDryRun).toHaveBeenCalledWith('rc_4', body);

    const stored = await request(app()).get('/api/v1/rate-cards/rc_4/impact').set('Authorization', `Bearer ${admin}`);
    expect(Object.keys(stored.body.data).sort()).toEqual(Object.keys(res.body.data).sort());
  });

  it('refuses a grid with a bad amount, and a publisher', async () => {
    const bad = await request(app()).post('/api/v1/rate-cards/rc_4/impact/dry-run').set('Authorization', `Bearer ${admin}`).send({ entries: [{ mediaTypeId: 'mt_1', grade: 'A', ratePerDay: 'twelve' }] });
    expect(bad.status).toBe(400);
    expect(service.cardImpactDryRun).not.toHaveBeenCalled();
    expect((await request(app()).post('/api/v1/rate-cards/rc_4/impact/dry-run').set('Authorization', `Bearer ${publisher}`).send({ entries: [] })).status).toBe(403);
  });
});
