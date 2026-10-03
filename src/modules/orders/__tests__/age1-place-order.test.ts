import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGE-1 (the owner, 29 Sep 2026): "You don't need to be over 18 to use ADX,
 * but you do need to be over 18 to place orders."
 *
 * `POST /orders` — the direct order an advertiser places — asks the person
 * placing it before the placement runs: 403 AGE_REQUIRED with no date of
 * birth on file or under 18, nothing placed.
 */

const { placement, ageGate } = vi.hoisted(() => ({
  placement: { placeOrder: vi.fn() },
  ageGate: { assertAdultForOrders: vi.fn() },
}));

vi.mock('../placement/placement.service', async (importOriginal) => ({ ...(await importOriginal<object>()), ...placement }));
vi.mock('../../../shared/age-gate', async (importOriginal) => ({ ...(await importOriginal<object>()), ...ageGate }));

import { ageRequiredError } from '../../../shared/age-gate';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { orderRouter } from '../orders.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/orders', orderRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const advertiser = tokenFor(['ADVERTISER'], 'usr_adv');

beforeEach(() => {
  vi.clearAllMocks();
  placement.placeOrder.mockResolvedValue({ id: 'ord_1', status: 'PENDING_PUBLISHER' });
});

describe('POST /orders', () => {
  it('refuses 403 AGE_REQUIRED before anything is placed', async () => {
    ageGate.assertAdultForOrders.mockRejectedValueOnce(ageRequiredError('MISSING'));
    const res = await request(app()).post('/api/v1/orders').set('Authorization', `Bearer ${advertiser}`).send({ listingId: 'lst_1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'AGE_REQUIRED', details: { reason: 'MISSING', self: true } });
    expect(ageGate.assertAdultForOrders).toHaveBeenCalledWith('usr_adv');
    expect(placement.placeOrder).not.toHaveBeenCalled();
  });

  it('places the order for someone 18 or over', async () => {
    ageGate.assertAdultForOrders.mockResolvedValueOnce(undefined);
    const res = await request(app()).post('/api/v1/orders').set('Authorization', `Bearer ${advertiser}`).send({ listingId: 'lst_1' });
    expect(res.status).toBe(201);
    expect(placement.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ listingId: 'lst_1' }));
  });
});
