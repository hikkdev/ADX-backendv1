import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E7-2 — the door on /payments.
 *
 * The checkout and return pages are served without a bearer, under the
 * page's headers; the confirm accepts a bearer as before, or the page's
 * one-time token in the body, and refuses a body carrying neither.
 */

const { service, pages, advertisers, agents, publishers } = vi.hoisted(() => ({
  service: {
    actorFromCheckoutToken: vi.fn(),
    confirmPayment: vi.fn(),
    createIntent: vi.fn(),
    getPayment: vi.fn(),
    handleWebhook: vi.fn(),
    listGateways: vi.fn(),
    listPaymentsPage: vi.fn(),
    refundPayment: vi.fn(),
    toPaymentView: vi.fn((payment: unknown) => payment),
  },
  pages: {
    checkoutPage: vi.fn(),
    returnPage: vi.fn(),
    returnUrlFor: vi.fn((id: string) => `http://api/api/v1/payments/${id}/return`),
    returnRedirectUrlFor: vi.fn(async (id: string, status: string) => `http://api/api/v1/payments/${id}/return?t=tok_r&status=${status}`),
  },
  advertisers: { assertMayActFor: vi.fn(), getAdvertiserForUser: vi.fn() },
  agents: { findAgentProfile: vi.fn() },
  // Lot J (B2): the controller resolves the publisher behind a session too.
  publishers: { findPublisherForUser: vi.fn() },
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../payments.service', () => service);
vi.mock('../checkout-page.service', () => pages);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../agents', () => agents);
vi.mock('../../publishers', () => publishers);
vi.mock('../../feature-flags', () => passThroughFeatureGates());

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { paymentRouter } from '../payments.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/payments', paymentRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const advertiser = tokenFor(['ADVERTISER'], 'usr_owner');

beforeEach(() => {
  vi.clearAllMocks();
  pages.checkoutPage.mockResolvedValue({ status: 200, html: '<!doctype html><title>Pay</title>', csp: "default-src 'none'" });
  pages.returnPage.mockResolvedValue({ status: 200, html: '<!doctype html><title>Paid</title>', csp: "default-src 'none'" });
  advertisers.getAdvertiserForUser.mockResolvedValue({ id: 'adv_1' });
  agents.findAgentProfile.mockResolvedValue(null);
  publishers.findPublisherForUser.mockResolvedValue(null);
  service.actorFromCheckoutToken.mockResolvedValue({ userId: 'usr_owner', isAdmin: false, advertiserId: 'adv_1', agentId: null });
  service.confirmPayment.mockResolvedValue({ id: 'pay_1', status: 'CAPTURED' });
});

describe('the browser pages', () => {
  it('serves the checkout page with no bearer, under its CSP and no-store', async () => {
    const res = await request(app()).get('/api/v1/payments/pay_1/checkout?t=tok');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(pages.checkoutPage).toHaveBeenCalledWith('pay_1', 'tok');
  });

  it('serves the return page with no bearer and passes the page status through', async () => {
    pages.returnPage.mockResolvedValue({ status: 404, html: '<!doctype html><title>Not found</title>', csp: "default-src 'none'" });
    const res = await request(app()).get('/api/v1/payments/pay_x/return?status=captured');
    expect(res.status).toBe(404);
    expect(pages.returnPage).toHaveBeenCalledWith('pay_x', undefined);
  });

  it('E9: hands the return page the ?t= token the gateway brought back', async () => {
    const res = await request(app()).get('/api/v1/payments/pay_1/return?t=tok_r&status=captured');
    expect(res.status).toBe(200);
    expect(pages.returnPage).toHaveBeenCalledWith('pay_1', 'tok_r');
  });

  it('still authenticates the read beneath them', async () => {
    expect((await request(app()).get('/api/v1/payments/pay_1')).status).toBe(401);
  });
});

describe('POST /payments/:id/confirm', () => {
  it('confirms under a bearer as before', async () => {
    const res = await request(app()).post('/api/v1/payments/pay_1/confirm').set('Authorization', `Bearer ${advertiser}`).send({ gatewayPaymentId: 'pay_X', signature: 'sig' });
    expect(res.status).toBe(200);
    expect(service.actorFromCheckoutToken).not.toHaveBeenCalled();
    expect(service.confirmPayment).toHaveBeenCalledWith('pay_1', expect.objectContaining({ gatewayPaymentId: 'pay_X', signature: 'sig' }), expect.objectContaining({ userId: 'usr_owner', advertiserId: 'adv_1', publisherId: null }));
  });

  it('Lot J (B2): a publisher session confirms as the publisher behind it', async () => {
    advertisers.getAdvertiserForUser.mockResolvedValue(null);
    publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1' });
    const res = await request(app()).post('/api/v1/payments/pay_1/confirm').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'], 'usr_pub')}`).send({ gatewayPaymentId: 'pay_X', signature: 'sig' });
    expect(res.status).toBe(200);
    expect(service.confirmPayment).toHaveBeenCalledWith('pay_1', expect.anything(), expect.objectContaining({ userId: 'usr_pub', advertiserId: null, publisherId: 'pub_1' }));
  });

  it("confirms under the page's one-time token, with Razorpay's field names", async () => {
    const res = await request(app())
      .post('/api/v1/payments/pay_1/confirm')
      .send({ razorpay_payment_id: 'pay_X', razorpay_order_id: 'order_1', razorpay_signature: 'sig', checkoutToken: 'ct' });
    expect(res.status).toBe(200);
    expect(service.actorFromCheckoutToken).toHaveBeenCalledWith('pay_1', 'ct');
    expect(service.confirmPayment).toHaveBeenCalledWith(
      'pay_1',
      expect.objectContaining({ gatewayPaymentId: 'pay_X', signature: 'sig', gatewayOrderId: 'order_1', checkoutToken: 'ct' }),
      expect.objectContaining({ userId: 'usr_owner' }),
    );
  });

  it('refuses a body with neither a bearer nor a token', async () => {
    const res = await request(app()).post('/api/v1/payments/pay_1/confirm').send({ gatewayPaymentId: 'pay_X', signature: 'sig' });
    expect(res.status).toBe(401);
    expect(service.confirmPayment).not.toHaveBeenCalled();
  });
});
