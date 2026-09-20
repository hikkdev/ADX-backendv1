import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-6 (17 Sep 2026) — the commercial agreement is presented when a listing
 * is submitted, not in the setup checklist.
 *
 * The owner: "Commercial Agreement should be presented after any listing is
 * getting submitted." Pinned: `POST /listings/:id/submit` by a publisher on
 * their own phone refuses 409 `AGREEMENT_REQUIRED` (with
 * `details.agreement = 'PLATFORM'` and the live version) while their
 * standing on the live publisher agreement is unsatisfied
 * (`agreements.platformStanding`); the listing stays a draft; once accepted
 * the same call submits it; while ADX has published no agreement nothing
 * gates; an agent's submit is not gated here — their
 * ladder carries its own acceptance — and the route admits no admin at all
 * (the desk's verbs are its own).
 */

const { service, features, agreements } = vi.hoisted(() => ({
  service: { findOwnPublisher: vi.fn(), assertCanEditListing: vi.fn(), submitListingForReview: vi.fn() },
  agreements: { platformStanding: vi.fn() },
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
vi.mock('../../agreements', () => agreements);

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
const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');
const admin = tokenFor(['ADMIN'], 'usr_admin');

const own = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  name: 'Asha Rao',
  mobile: '+919876543210',
  email: 'asha@example.com',
  address: '12 MG Road, Bengaluru',
  dateOfBirth: new Date('1990-04-12T00:00:00Z'),
  activatedAt: null,
  ...over,
});

const submit = (token = publisher) => request(app()).post('/api/v1/listings/lst_1/submit').set('Authorization', `Bearer ${token}`).send({});

const standing = (over: Record<string, unknown> = {}) => ({ kind: 'PLATFORM', currentVersion: 2, requiresReacceptance: false, accepted: null, satisfied: false, outdated: false, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  agreements.platformStanding.mockResolvedValue(standing());
  service.assertCanEditListing.mockResolvedValue(undefined);
  service.submitListingForReview.mockResolvedValue({ id: 'lst_1', status: 'PENDING_REVIEW', displayId: 'LST-1' });
});

describe('POST /listings/:id/submit — the commercial agreement', () => {
  it('refuses 409 AGREEMENT_REQUIRED while the publisher has not accepted, and files nothing', async () => {
    service.findOwnPublisher.mockResolvedValue(own());
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AGREEMENT_REQUIRED');
    expect(res.body.error.details).toEqual({ agreement: 'PLATFORM', version: 2 });
    expect(res.body.error.message).toContain('publisher agreement');
    expect(agreements.platformStanding).toHaveBeenCalledWith('PLATFORM', { publisherId: 'pub_1' });
    expect(service.submitListingForReview).not.toHaveBeenCalled();
  });

  it('submits once the agreement is accepted', async () => {
    service.findOwnPublisher.mockResolvedValue(own({ activatedAt: new Date('2026-09-10T00:00:00Z') }));
    agreements.platformStanding.mockResolvedValue(standing({ satisfied: true, accepted: { templateVersion: 2 } }));
    const res = await submit();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'PENDING_REVIEW' });
    expect(service.submitListingForReview).toHaveBeenCalledWith('lst_1');
  });

  it('does not gate while ADX has published no agreement — there is nothing to accept', async () => {
    service.findOwnPublisher.mockResolvedValue(own());
    agreements.platformStanding.mockResolvedValue(standing({ currentVersion: null }));
    expect((await submit()).status).toBe(200);
  });

  it('gates again when ADX publishes a new version that requires re-acceptance', async () => {
    service.findOwnPublisher.mockResolvedValue(own({ activatedAt: new Date('2026-09-10T00:00:00Z') }));
    agreements.platformStanding.mockResolvedValue(standing({ currentVersion: 3, requiresReacceptance: true, accepted: { templateVersion: 2 }, satisfied: false, outdated: true }));
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ agreement: 'PLATFORM', version: 3 });
  });

  it("does not gate an agent's submit (ADX's desk has its own verbs — the route admits no admin)", async () => {
    service.findOwnPublisher.mockResolvedValue(own());
    expect((await submit(agent)).status).toBe(200);
    expect(service.findOwnPublisher).not.toHaveBeenCalled();
    expect(agreements.platformStanding).not.toHaveBeenCalled();
    expect((await submit(admin)).status).toBe(403);
  });

  it('still refuses first on the ownership rule, before the agreement is looked at', async () => {
    const { ApiError } = await import('../../../shared/errors');
    service.assertCanEditListing.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'not yours'));
    service.findOwnPublisher.mockResolvedValue(own());
    const res = await submit();
    expect(res.status).toBe(403);
    expect(service.findOwnPublisher).not.toHaveBeenCalled();
  });
});
