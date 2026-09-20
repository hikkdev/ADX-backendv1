import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-3 — the listing door for a publisher on their own phone.
 *
 * Pinned: `POST /listings` as a self-serve PUBLISHER is refused 409
 * `PROFILE_INCOMPLETE` — naming exactly the basics that are missing, in the
 * ladder's order, and saying the identity check is what makes a spot go
 * live — until the name, email and address are on the record; with them in,
 * the spot is filed under the caller's own record as before (a `publisherId`
 * in the body still ignored); a name that is still the mobile number counts
 * as missing; the door is the publisher's, so an agent's or ADX's create is
 * not gated here (their ladder and desk are).
 */

const { service, features } = vi.hoisted(() => ({
  service: { findOwnPublisher: vi.fn(), createListing: vi.fn() },
  features: () => ({
    requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

vi.mock('../listings.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../listings.service')>();
  return { ...actual, ...service };
});
vi.mock('../../feature-flags', () => features());

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { listingRouter } from '../listings.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/listings', listingRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const publisher = tokenFor(['PUBLISHER'], 'usr_pub');

const own = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  name: 'Asha Rao',
  mobile: '+919876543210',
  email: 'asha@example.com',
  address: '12 MG Road, Bengaluru',
  // QR-5: the date of birth joined the basics.
  dateOfBirth: new Date('1990-04-12T00:00:00Z'),
  // QR-6: the publisher agreement, accepted — the submit gate reads it, not the door.
  activatedAt: new Date('2026-09-10T00:00:00Z'),
  ...over,
});

const spot = {
  title: 'MG Road hoarding',
  category: 'OUTDOOR',
  city: 'Bengaluru',
  address: '12 MG Road',
  ratePerDay: '1500',
  publisherId: 'pub_SOMEONE_ELSE',
};

const post = (body: object, token = publisher) => request(app()).post('/api/v1/listings').set('Authorization', `Bearer ${token}`).send(body);

beforeEach(() => {
  vi.clearAllMocks();
  service.createListing.mockImplementation(async (draft: { publisherId: string }) => ({ id: 'lst_1', status: 'DRAFT', publisherId: draft.publisherId }));
});

describe('POST /listings as a publisher on their own phone', () => {
  it('refuses 409 PROFILE_INCOMPLETE naming the basics that are missing, and files nothing', async () => {
    service.findOwnPublisher.mockResolvedValue(own({ name: '+919876543210', email: null, address: '', dateOfBirth: null }));
    const res = await post(spot);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROFILE_INCOMPLETE');
    expect(res.body.error.message).toBe(
      'Add your name, an email address, your address and your date of birth to your profile before listing a spot. Spots you add are reviewed by ADX; verified profiles and their spots are shown first to advertisers.',
    );
    expect(res.body.error.details).toEqual({ missing: ['name', 'email', 'address', 'dateOfBirth'] });
    expect(service.createListing).not.toHaveBeenCalled();
  });

  it('one missing basic is named alone', async () => {
    service.findOwnPublisher.mockResolvedValue(own({ email: null }));
    const res = await post(spot);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ missing: ['email'] });
    expect(res.body.error.message).toContain('Add an email address to your profile');
  });

  it('with the basics in, files the spot under the caller\'s own record and ignores a publisherId in the body', async () => {
    service.findOwnPublisher.mockResolvedValue(own());
    const res = await post(spot);
    expect(res.status).toBe(201);
    expect(service.createListing).toHaveBeenCalledTimes(1);
    expect(service.createListing.mock.calls[0]![0]).toMatchObject({ publisherId: 'pub_1', title: 'MG Road hoarding' });
  });

  it('a login with no publisher record is still 403, before any basics are looked at', async () => {
    service.findOwnPublisher.mockResolvedValue(null);
    const res = await post(spot);
    expect(res.status).toBe(403);
    expect(service.createListing).not.toHaveBeenCalled();
  });
});
