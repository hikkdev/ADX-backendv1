import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot J2 (e) — the door on the publisher-plan routes.
 *
 * `requireFeature('revenue.publisher-plans')` sits on the order routes and
 * the phone's screen: with the switch off every one of them answers **503
 * FEATURE_OFF** `{ key }`, before the handler runs. The J-M lane saw a 404
 * on `/subscriptions/me` and read it as the switch; it is not — with the
 * switch on, a login that has no publisher record is answered 404
 * NOT_FOUND "No publisher account for this user" by the handler itself,
 * which is what a console admin's token gets. Both are pinned here with
 * the real guard over a mocked flag state, so the two cannot be confused
 * again. Lot J2's own routes — the trial, the auto-renew switch — sit
 * behind the same guard.
 */

const { flags, service, publishers } = vi.hoisted(() => ({
  flags: { featureAnswer: vi.fn() },
  service: {
    cancelSubscriptionOrder: vi.fn(),
    createSubscriptionOrder: vi.fn(),
    getSubscriptionOrder: vi.fn(),
    listPlans: vi.fn(),
    listSubscriptionOrdersPage: vi.fn(),
    listSubscriptionsPage: vi.fn(),
    mySubscription: vi.fn(),
    orderView: vi.fn((row: unknown) => row),
    paySubscriptionOrderFromWallet: vi.fn(),
    quoteSubscriptionOrder: vi.fn(),
    recordSubscriptionOrderPayment: vi.fn(),
    setMySubscriptionAutoRenew: vi.fn(),
    startSubscriptionTrial: vi.fn(),
    updatePlan: vi.fn(),
    findPlan: vi.fn(),
    publisherPlansByTier: vi.fn(),
  },
  publishers: { findPublisherForUser: vi.fn() },
}));

vi.mock('../publisher-plans.service', () => service);
vi.mock('../revenue.service', () => ({
  grantCommissionOverride: vi.fn(),
  grantSubscription: vi.fn(),
  heldRate: vi.fn(),
  lockPrice: vi.fn(),
  quote: vi.fn(),
  setCommissionRate: vi.fn(),
}));
vi.mock('../prisma-revenue.repository', () => ({ prismaRevenueRepository: {} }));
vi.mock('../../publishers', () => publishers);
vi.mock('../../advertisers', () => ({ getAdvertiserForUser: vi.fn() }));
// The real `requireFeature`, over a mocked flag state.
vi.mock('../../feature-flags/feature-flags.service', () => flags);

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { revenueRouter } from '../revenue.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/revenue', revenueRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const publisher = tokenFor(['PUBLISHER'], 'usr_pub');
const admin = tokenFor(['ADMIN'], 'usr_admin');

beforeEach(() => {
  vi.clearAllMocks();
  flags.featureAnswer.mockResolvedValue({ enabled: true });
  publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1' });
  service.mySubscription.mockResolvedValue({ running: null, upcoming: [], orders: [], catalogue: [], options: [], canBuy: true, reason: null, trialAvailable: {} });
  service.quoteSubscriptionOrder.mockResolvedValue({ total: '2948.82' });
  service.startSubscriptionTrial.mockResolvedValue({ order: { id: 'ord_t' }, subscription: { id: 'sub_t' } });
  service.setMySubscriptionAutoRenew.mockResolvedValue({ id: 'sub_1', autoRenew: true });
  service.listSubscriptionsPage.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, counts: { RUNNING: 0, UPCOMING: 0, ENDED: 0 } });
});

describe('with the revenue.publisher-plans switch off', () => {
  beforeEach(() => flags.featureAnswer.mockResolvedValue({ enabled: false }));

  it.each([
    ['GET', '/api/v1/revenue/subscriptions/me'],
    ['PATCH', '/api/v1/revenue/subscriptions/me'],
    ['POST', '/api/v1/revenue/subscription-orders/quote'],
    ['POST', '/api/v1/revenue/subscription-orders'],
    ['POST', '/api/v1/revenue/subscription-orders/trial'],
    ['GET', '/api/v1/revenue/subscription-orders/ord_1'],
    ['POST', '/api/v1/revenue/subscription-orders/ord_1/pay'],
    ['POST', '/api/v1/revenue/subscription-orders/ord_1/cancel'],
  ])('%s %s answers 503 FEATURE_OFF naming the key, before the handler runs', async (method, path) => {
    const res = await request(app())[method.toLowerCase() as 'get' | 'post' | 'patch'](path).set('Authorization', `Bearer ${publisher}`).send({ tier: 'PLUS', cycle: 'MONTHLY', autoRenew: true });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'FEATURE_OFF', details: { key: 'revenue.publisher-plans' } });
    expect(service.mySubscription).not.toHaveBeenCalled();
    expect(service.quoteSubscriptionOrder).not.toHaveBeenCalled();
    expect(publishers.findPublisherForUser).not.toHaveBeenCalled();
  });

  it('leaves the catalogue read, its editor and the console list alone — the switch is on the purchase, not the plans', async () => {
    service.listPlans.mockResolvedValue([]);
    expect((await request(app()).get('/api/v1/revenue/plans').set('Authorization', `Bearer ${publisher}`)).status).toBe(200);
    expect((await request(app()).get('/api/v1/revenue/subscriptions').set('Authorization', `Bearer ${admin}`)).status).toBe(200);
  });
});

describe('with the switch on', () => {
  it('GET /subscriptions/me answers the publisher their screen, and 404 NOT_FOUND — not FEATURE_OFF — to a login with no publisher record', async () => {
    const mine = await request(app()).get('/api/v1/revenue/subscriptions/me').set('Authorization', `Bearer ${publisher}`);
    expect(mine.status).toBe(200);
    expect(service.mySubscription).toHaveBeenCalledWith('pub_1');

    publishers.findPublisherForUser.mockResolvedValue(null);
    const notAPublisher = await request(app()).get('/api/v1/revenue/subscriptions/me').set('Authorization', `Bearer ${admin}`);
    expect(notAPublisher.status).toBe(404);
    expect(notAPublisher.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'No publisher account for this user' });
  });

  it('POST /subscription-orders/trial starts the trial for the publisher behind the session, 201', async () => {
    const res = await request(app()).post('/api/v1/revenue/subscription-orders/trial').set('Authorization', `Bearer ${publisher}`).send({ tier: 'PLUS' });
    expect(res.status).toBe(201);
    expect(service.startSubscriptionTrial).toHaveBeenCalledWith({ publisherId: 'pub_1', userId: 'usr_pub', tier: 'PLUS' });
    expect((await request(app()).post('/api/v1/revenue/subscription-orders/trial').set('Authorization', `Bearer ${publisher}`).send({ tier: 'GOLD' })).status).toBe(400);
  });

  it('PATCH /subscriptions/me { autoRenew } sets the flag for the publisher behind the session; a stray key is refused', async () => {
    const res = await request(app()).patch('/api/v1/revenue/subscriptions/me').set('Authorization', `Bearer ${publisher}`).send({ autoRenew: true });
    expect(res.status).toBe(200);
    expect(service.setMySubscriptionAutoRenew).toHaveBeenCalledWith('pub_1', true);
    expect((await request(app()).patch('/api/v1/revenue/subscriptions/me').set('Authorization', `Bearer ${publisher}`).send({ autoRenew: true, tier: 'PRO' })).status).toBe(400);
  });

  it('GET /subscriptions (ADMIN) is the list contract, with the state facet, the search and the publisher filter parsed', async () => {
    const res = await request(app()).get('/api/v1/revenue/subscriptions?state=RUNNING&q=asha&publisherId=pub_1&page=2&pageSize=10').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(service.listSubscriptionsPage).toHaveBeenCalledWith({ state: 'RUNNING', q: 'asha', publisherId: 'pub_1', page: 2, pageSize: 10 });
    expect(res.body.data).toMatchObject({ items: [], total: 0, counts: { RUNNING: 0, UPCOMING: 0, ENDED: 0 } });
    expect((await request(app()).get('/api/v1/revenue/subscriptions?state=LAPSED').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
    expect((await request(app()).get('/api/v1/revenue/subscriptions').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
  });
});
