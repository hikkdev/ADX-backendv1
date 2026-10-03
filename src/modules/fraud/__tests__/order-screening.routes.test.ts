import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Order fraud screening (2 Oct 2026) — the review desk's routes.
 *
 * Pinned: every route is ADMIN with the fraud desk's permissions (read
 * `kyc.view`, act `kyc.edit`, cancel as fraud also `marketplace.edit`); the
 * router mounted ahead of the orders router lets every other `/orders`
 * request through; bodies are validated; every act is audited against the
 * order under its own action; and the bulk route answers per order — the
 * ones that landed, the ones that did not and why — at most a hundred.
 */

const h = vi.hoisted(() => ({
  service: {
    cancelImpact: vi.fn(),
    clearReview: vi.fn(),
    confirmFraud: vi.fn(),
    holdForReview: vi.fn(),
    listFraudReview: vi.fn(),
    openOrderFraudCase: vi.fn(),
    releaseFromReview: vi.fn(),
    screenOrder: vi.fn(),
  },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../order-screening/order-screening.service', () => h.service);
vi.mock('../../../shared/audit', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/audit')>()), logActivity: h.audit.logActivity }));

import { errorHandler, ApiError } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import { tokenFor } from '../../../shared/testing';
import { orderScreeningRouter } from '../order-screening/order-screening.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const orders = Router();
  // Stands in for the orders router mounted after the desk's: what falls through lands here.
  orders.get('/my', (_req, res) => void res.json({ success: true, data: 'my orders' }));
  orders.get('/:id', (req, res) => void res.json({ success: true, data: `order ${req.params['id']}` }));
  instance.use('/orders', orderScreeningRouter);
  instance.use('/orders', orders);
  instance.use(errorHandler);
  return instance;
}

const ADMIN = `Bearer ${tokenFor(['ADMIN'], 'usr_admin')}`;
const narrow = (perms: string[]) => `Bearer ${signAccessToken('usr_narrow', ['ADMIN'], undefined, { perms })}`;
const ADVERTISER = `Bearer ${tokenFor(['ADVERTISER'], 'usr_adv')}`;

const state = (over: Record<string, unknown> = {}) => ({ id: 'ord_1', displayId: 'BKG-1', status: 'PENDING_AGENT', riskReviewStatus: 'FLAGGED', heldAt: null, ...over });
const change = (after: Record<string, unknown>) => ({ before: state(), after: state(after) });

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.logActivity.mockResolvedValue(undefined);
  h.service.listFraudReview.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, counts: { FLAGGED: 0, HELD: 0, CLEARED: 0, CONFIRMED: 0, ALL: 0 } });
  h.service.holdForReview.mockResolvedValue(change({ heldAt: '2026-10-02T12:00:00.000Z', holdReason: 'Same bank' }));
  h.service.releaseFromReview.mockResolvedValue(change({ heldAt: null }));
  h.service.clearReview.mockResolvedValue(change({ riskReviewStatus: 'CLEARED', riskClearedSignalKeys: ['ORDER:LINKED_PARTIES'] }));
  h.service.confirmFraud.mockResolvedValue({ ...change({ riskReviewStatus: 'CONFIRMED_FRAUD', status: 'CANCELLED' }), refunds: [] });
  h.service.cancelImpact.mockResolvedValue({ orderId: 'ord_1', cancellable: true });
  h.service.screenOrder.mockResolvedValue({ ...change({ riskScore: '0.420' }), score: { score: 0.42, band: 'LOW', signals: [] }, held: false, outcome: {} });
  h.service.openOrderFraudCase.mockResolvedValue({
    ...change({ fraudCaseId: 'frd_1' }),
    fraudCase: { id: 'frd_1', displayId: 'FRD-1', status: 'OPEN', subjectType: 'ADVERTISER', subjectId: 'adv_1', kind: 'ORDER_FRAUD' },
    opened: true,
    attached: false,
  });
});

const actions = () => h.audit.logActivity.mock.calls.map((call) => call[1]);

describe('who may use the desk', () => {
  it('refuses a party and an admin without the desk’s permission', async () => {
    await request(app()).get('/orders/fraud-review').set('Authorization', ADVERTISER).expect(403);
    await request(app()).get('/orders/fraud-review').set('Authorization', narrow(['marketplace.view'])).expect(403);
    await request(app()).post('/orders/ord_1/hold').set('Authorization', narrow(['kyc.view'])).send({ reason: 'Same bank' }).expect(403);
    expect(h.service.listFraudReview).not.toHaveBeenCalled();
    expect(h.service.holdForReview).not.toHaveBeenCalled();
  });

  it('asks for the orders cancel permission as well to cancel as fraud', async () => {
    await request(app()).post('/orders/ord_1/confirm-fraud').set('Authorization', narrow(['kyc.view', 'kyc.edit'])).send({ reason: 'Stolen card' }).expect(403);
    await request(app()).post('/orders/ord_1/confirm-fraud').set('Authorization', narrow(['kyc.edit', 'marketplace.edit'])).send({ reason: 'Stolen card' }).expect(200);
  });

  it('lets every other /orders request through to the orders router', async () => {
    const my = await request(app()).get('/orders/my').set('Authorization', ADVERTISER).expect(200);
    expect(my.body.data).toBe('my orders');
    const one = await request(app()).get('/orders/ord_9').set('Authorization', ADVERTISER).expect(200);
    expect(one.body.data).toBe('order ord_9');
  });
});

describe('GET /orders/fraud-review', () => {
  it('defaults to the flagged orders by score, and takes the tab and sort in any case', async () => {
    const res = await request(app()).get('/orders/fraud-review').set('Authorization', ADMIN).expect(200);
    expect(res.body.data.counts).toEqual({ FLAGGED: 0, HELD: 0, CLEARED: 0, CONFIRMED: 0, ALL: 0 });
    expect(h.service.listFraudReview).toHaveBeenLastCalledWith({ status: 'FLAGGED', sort: 'score', page: 1, pageSize: 20 });
    await request(app()).get('/orders/fraud-review?status=held&sort=NEWEST&q=Kumar&page=2&pageSize=50').set('Authorization', ADMIN).expect(200);
    expect(h.service.listFraudReview).toHaveBeenLastCalledWith({ status: 'HELD', sort: 'newest', q: 'Kumar', page: 2, pageSize: 50 });
  });

  it('refuses a tab it does not know', async () => {
    await request(app()).get('/orders/fraud-review?status=SUSPICIOUS').set('Authorization', ADMIN).expect(400);
  });
});

describe('the single-order acts', () => {
  it('hold needs a reason, and is audited ORDER_HELD', async () => {
    await request(app()).post('/orders/ord_1/hold').set('Authorization', ADMIN).send({}).expect(400);
    const res = await request(app()).post('/orders/ord_1/hold').set('Authorization', ADMIN).send({ reason: 'Same bank as the publisher' }).expect(200);
    expect(res.body.data).toMatchObject({ id: 'ord_1', heldAt: '2026-10-02T12:00:00.000Z' });
    expect(h.service.holdForReview).toHaveBeenCalledWith('ord_1', { sub: 'usr_admin', roles: ['ADMIN'] }, 'Same bank as the publisher');
    expect(h.audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ORDER_HELD', expect.objectContaining({ targetType: 'Order', targetId: 'ord_1', metadata: expect.objectContaining({ reason: 'Same bank as the publisher', automatic: false }) }));
  });

  it('release, clear, confirm-fraud and rescore are each audited under their own action', async () => {
    await request(app()).post('/orders/ord_1/release').set('Authorization', ADMIN).send({ note: 'Called them' }).expect(200);
    await request(app()).post('/orders/ord_1/clear').set('Authorization', ADMIN).send({}).expect(200);
    const confirmed = await request(app()).post('/orders/ord_1/confirm-fraud').set('Authorization', ADMIN).send({ reason: 'Stolen card' }).expect(200);
    expect(confirmed.body.data).toMatchObject({ riskReviewStatus: 'CONFIRMED_FRAUD', refunds: [] });
    const rescored = await request(app()).post('/orders/ord_1/rescore').set('Authorization', ADMIN).expect(200);
    expect(rescored.body.data).toMatchObject({ riskScore: '0.420', held: false });
    expect(h.service.screenOrder).toHaveBeenCalledWith('ord_1', { trigger: 'MANUAL' });
    expect(actions()).toEqual(['ORDER_RELEASED', 'ORDER_RISK_CLEARED', 'ORDER_CONFIRMED_FRAUD', 'ORDER_RESCORED']);
  });

  it('confirm-fraud needs a reason', async () => {
    await request(app()).post('/orders/ord_1/confirm-fraud').set('Authorization', ADMIN).send({ reason: '' }).expect(400);
    expect(h.service.confirmFraud).not.toHaveBeenCalled();
  });

  it('a refusal from the service is the answer (409 ORDER_LIVE)', async () => {
    h.service.confirmFraud.mockRejectedValue(new ApiError(409, 'ORDER_LIVE', 'The advertisement on this order is already up … raise a dispute'));
    const res = await request(app()).post('/orders/ord_1/confirm-fraud').set('Authorization', ADMIN).send({ reason: 'Stolen card' }).expect(409);
    expect(res.body.error?.code ?? res.body.code).toBe('ORDER_LIVE');
    expect(h.audit.logActivity).not.toHaveBeenCalled();
  });

  it('cancel-impact reads, writes nothing', async () => {
    const res = await request(app()).get('/orders/ord_1/cancel-impact').set('Authorization', ADMIN).expect(200);
    expect(res.body.data).toEqual({ orderId: 'ord_1', cancellable: true });
    expect(h.audit.logActivity).not.toHaveBeenCalled();
  });

  it('fraud-case: 201 when a case was opened, audited as the case opening and the order’s link', async () => {
    const res = await request(app()).post('/orders/ord_1/fraud-case').set('Authorization', ADMIN).expect(201);
    expect(res.body.data).toMatchObject({ fraudCaseId: 'frd_1', fraudCase: { id: 'frd_1', displayId: 'FRD-1', status: 'OPEN' }, opened: true, attached: false, order: { fraudCaseId: 'frd_1' } });
    expect(actions()).toEqual(['FRAUD_CASE_OPENED', 'ORDER_FRAUD_CASE_LINKED']);
    h.service.openOrderFraudCase.mockResolvedValue({ ...change({ fraudCaseId: 'frd_1' }), fraudCase: { id: 'frd_1', displayId: 'FRD-1', status: 'OPEN' }, opened: false, attached: true });
    await request(app()).post('/orders/ord_1/fraud-case').set('Authorization', ADMIN).expect(200);
  });
});

describe('POST /orders/fraud-review/bulk', () => {
  it('answers per order — mixed results — and audits only what landed', async () => {
    h.service.holdForReview
      .mockResolvedValueOnce(change({ heldAt: 'x' }))
      .mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'This order is already on hold.'))
      .mockRejectedValueOnce(new Error('boom'));
    const res = await request(app())
      .post('/orders/fraud-review/bulk')
      .set('Authorization', ADMIN)
      .send({ action: 'hold', orderIds: ['ord_1', 'ord_2', 'ord_3', 'ord_1'], reason: 'Same bank ring' })
      .expect(200);
    expect(res.body.data).toEqual({
      action: 'HOLD',
      results: [
        { id: 'ord_1', ok: true },
        { id: 'ord_2', ok: false, code: 'CONFLICT', message: 'This order is already on hold.' },
        { id: 'ord_3', ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong with this order. Try it on its own.' },
      ],
      succeeded: 1,
      failed: 2,
    });
    expect(actions()).toEqual(['ORDER_HELD']);
  });

  it('needs a reason to hold or cancel as fraud, takes at most a hundred, and knows its four actions', async () => {
    await request(app()).post('/orders/fraud-review/bulk').set('Authorization', ADMIN).send({ action: 'HOLD', orderIds: ['ord_1'] }).expect(400);
    await request(app()).post('/orders/fraud-review/bulk').set('Authorization', ADMIN).send({ action: 'CONFIRM_FRAUD', orderIds: ['ord_1'] }).expect(400);
    await request(app())
      .post('/orders/fraud-review/bulk')
      .set('Authorization', ADMIN)
      .send({ action: 'RELEASE', orderIds: Array.from({ length: 101 }, (_, i) => `ord_${i}`) })
      .expect(400);
    await request(app()).post('/orders/fraud-review/bulk').set('Authorization', ADMIN).send({ action: 'SUSPEND', orderIds: ['ord_1'] }).expect(400);
    await request(app()).post('/orders/fraud-review/bulk').set('Authorization', ADMIN).send({ action: 'RELEASE', orderIds: [] }).expect(400);
    const released = await request(app()).post('/orders/fraud-review/bulk').set('Authorization', ADMIN).send({ action: 'RELEASE', orderIds: ['ord_1', 'ord_2'] }).expect(200);
    expect(released.body.data.succeeded).toBe(2);
    const cleared = await request(app()).post('/orders/fraud-review/bulk').set('Authorization', ADMIN).send({ action: 'CLEAR', orderIds: ['ord_1'] }).expect(200);
    expect(cleared.body.data.succeeded).toBe(1);
  });

  it('cancel as fraud in bulk needs the orders cancel permission, asked once', async () => {
    await request(app()).post('/orders/fraud-review/bulk').set('Authorization', narrow(['kyc.edit'])).send({ action: 'CONFIRM_FRAUD', orderIds: ['ord_1'], reason: 'Ring' }).expect(403);
    expect(h.service.confirmFraud).not.toHaveBeenCalled();
    const res = await request(app()).post('/orders/fraud-review/bulk').set('Authorization', ADMIN).send({ action: 'CONFIRM_FRAUD', orderIds: ['ord_1', 'ord_2'], reason: 'Ring' }).expect(200);
    expect(res.body.data.succeeded).toBe(2);
    expect(h.service.confirmFraud).toHaveBeenCalledWith('ord_2', { sub: 'usr_admin', roles: ['ADMIN'] }, 'Ring');
  });
});
