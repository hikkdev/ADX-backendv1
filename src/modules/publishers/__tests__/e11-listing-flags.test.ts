import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E11-1: the publisher's own listing rows, and the agent's read of the same
 * spots, carry `belowFloor` — the chip the admin table has had since Lot E —
 * stamped through rate-cards' `belowFloorFlags`, so what the phone shows and
 * what ops see never disagree about where a price sits.
 */

const { service, listings, rateCards } = vi.hoisted(() => ({
  service: { getOwnedPublisher: vi.fn() },
  listings: { getListingsForPublisher: vi.fn() },
  rateCards: { belowFloorFlags: vi.fn() },
}));

vi.mock('../publishers.service', () => service);
vi.mock('../../listings', () => listings);
vi.mock('../../rate-cards', () => rateCards);
vi.mock('../../ai', () => ({ translateListings: vi.fn(async (rows: unknown[]) => rows) }));
vi.mock('../../agents', () => ({ agentExists: vi.fn(), requireAgentProfile: vi.fn() }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn() }));

import { errorHandler } from '../../../shared/errors';
import { asyncHandler } from '../../../shared/http';
import { tokenFor } from '../../../shared/testing';
import { authenticate } from '../../../shared/auth';
import { getPublisherListingsHandler } from '../publishers.controller';

function app() {
  const instance = express();
  instance.get('/api/v1/publishers/:publisherId/listings', authenticate, asyncHandler(getPublisherListingsHandler));
  instance.use(errorHandler);
  return instance;
}

const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');

beforeEach(() => {
  vi.clearAllMocks();
  service.getOwnedPublisher.mockResolvedValue({ id: 'pub_1' });
  listings.getListingsForPublisher.mockResolvedValue([
    { id: 'lst_1', title: 'MG Road Billboard', status: 'ACTIVE', photos: [] },
    { id: 'lst_2', title: 'Brigade Road Kiosk', status: 'DRAFT', photos: [] },
  ]);
  rateCards.belowFloorFlags.mockResolvedValue({ lst_1: true });
});

describe('GET /publishers/:publisherId/listings', () => {
  it('stamps belowFloor on every row, false where the flags say nothing', async () => {
    const res = await request(app()).get('/api/v1/publishers/pub_1/listings').set('Authorization', `Bearer ${agent}`);
    expect(res.status).toBe(200);
    expect(rateCards.belowFloorFlags).toHaveBeenCalledWith(['lst_1', 'lst_2']);
    expect(res.body.data).toEqual([
      { id: 'lst_1', title: 'MG Road Billboard', status: 'ACTIVE', photos: [], belowFloor: true },
      { id: 'lst_2', title: 'Brigade Road Kiosk', status: 'DRAFT', photos: [], belowFloor: false },
    ]);
  });

  it('asks for no flags over an empty book', async () => {
    listings.getListingsForPublisher.mockResolvedValue([]);
    const res = await request(app()).get('/api/v1/publishers/pub_1/listings').set('Authorization', `Bearer ${agent}`);
    expect(res.body.data).toEqual([]);
    expect(rateCards.belowFloorFlags).not.toHaveBeenCalled();
  });
});
