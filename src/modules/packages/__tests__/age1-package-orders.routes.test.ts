import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGE-1 (the owner, 29 Sep 2026): "You don't need to be over 18 to use ADX,
 * but you do need to be over 18 to place orders."
 *
 * The package doors that place an order ask the advertiser's account
 * holder: the advertiser buying for themselves (`POST /packages/sales`),
 * paying from the wallet (`POST /packages/sales/:id/pay`), and the desk
 * recording money that arrived outside ADX (`POST /sales/:id/record-payment`
 * — the advertiser's person, not the admin's). An agent raising a sale only
 * sends the link; the advertiser's own payment asks. Pinned at the route
 * with the real router over a mocked service, before any money moves.
 */

const { service, advertisers, agents, repository, ageGate } = vi.hoisted(() => ({
  service: {
    sellPackage: vi.fn(),
    getSale: vi.fn(),
    findSale: vi.fn(),
    assertPayable: vi.fn(),
    assertSaleTermsAccepted: vi.fn(),
    assertWalletPaymentOffered: vi.fn(),
    markPaid: vi.fn(),
  },
  advertisers: { getAdvertiserForUser: vi.fn(), assertNotSuspended: vi.fn(), payForPackage: vi.fn() },
  agents: (() => { const o = { findAgentProfile: vi.fn() }; return { ...o, findWorkingAgentProfile: o.findAgentProfile }; })(),
  repository: { advertiserContext: vi.fn() },
  ageGate: { assertPartyAdultForOrders: vi.fn() },
}));

vi.mock('../packages.service', () => service);
vi.mock('../prisma-packages.repository', () => ({ prismaPackagesRepository: repository }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../agents', () => agents);
vi.mock('../../../shared/security/rate-limit', () => ({
  packageLinkLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../shared/age-gate', async (importOriginal) => ({ ...(await importOriginal<object>()), ...ageGate }));

import { ageRequiredError } from '../../../shared/age-gate';
import { ApiError, errorHandler } from '../../../shared/errors';
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

const pendingSale = { id: 'sale_1', advertiserId: 'adv_1', status: 'PENDING', total: '29498.82', packageName: 'Growth', reference: 'PKG-2026-000001' };

beforeEach(() => {
  vi.clearAllMocks();
  advertisers.getAdvertiserForUser.mockImplementation(async (userId: string) => (userId === 'usr_adv' ? { id: 'adv_1' } : null));
  agents.findAgentProfile.mockImplementation(async (userId: string) => (userId === 'usr_agent' ? { id: 'agt_1' } : null));
  repository.advertiserContext.mockImplementation(async (id: string) => (id === 'adv_1' ? { id: 'adv_1', agentId: 'agt_1' } : null));
  service.getSale.mockResolvedValue(pendingSale);
  service.findSale.mockResolvedValue(pendingSale);
  /* Reaching the sale itself means the gate let it through. */
  service.sellPackage.mockRejectedValue(new ApiError(409, 'CONFLICT', 'reached the sale'));
});

describe('POST /packages/sales', () => {
  it('the advertiser buying for themselves is asked, and a refusal sells nothing', async () => {
    ageGate.assertPartyAdultForOrders.mockRejectedValueOnce(ageRequiredError('MISSING'));
    const res = await request(app()).post('/api/v1/packages/sales').set('Authorization', `Bearer ${advertiser}`).send({ tier: 'GROWTH' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'AGE_REQUIRED', message: 'Add your date of birth to place an order — you need to be 18 or over.', details: { reason: 'MISSING', self: true } });
    expect(ageGate.assertPartyAdultForOrders).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' }, { actorUserId: 'usr_adv' });
    expect(service.sellPackage).not.toHaveBeenCalled();
  });

  it('an agent raising the sale only sends the link — nothing is asked yet', async () => {
    const res = await request(app()).post('/api/v1/packages/sales').set('Authorization', `Bearer ${agent}`).send({ advertiserId: 'adv_1', tier: 'GROWTH' });
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', message: 'reached the sale' });
    expect(ageGate.assertPartyAdultForOrders).not.toHaveBeenCalled();
  });
});

describe('POST /packages/sales/:id/pay', () => {
  it('is refused before the wallet is touched', async () => {
    ageGate.assertPartyAdultForOrders.mockRejectedValueOnce(ageRequiredError('UNDER_18'));
    const res = await request(app()).post('/api/v1/packages/sales/sale_1/pay').set('Authorization', `Bearer ${advertiser}`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'AGE_REQUIRED', message: 'You need to be 18 or over to place an order.', details: { reason: 'UNDER_18' } });
    expect(advertisers.payForPackage).not.toHaveBeenCalled();
    expect(service.markPaid).not.toHaveBeenCalled();
  });
});

describe('POST /packages/sales/:id/record-payment (the desk)', () => {
  it("asks the advertiser's person, not the admin's, and records nothing on a refusal", async () => {
    ageGate.assertPartyAdultForOrders.mockRejectedValueOnce(ageRequiredError('MISSING', false));
    const res = await request(app()).post('/api/v1/packages/sales/sale_1/record-payment').set('Authorization', `Bearer ${admin}`).send({ method: 'OFFLINE', reference: 'UTR123' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'AGE_REQUIRED', details: { reason: 'MISSING', self: false } });
    expect(ageGate.assertPartyAdultForOrders).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' }, { actorUserId: 'usr_admin' });
    expect(service.markPaid).not.toHaveBeenCalled();
  });
});
