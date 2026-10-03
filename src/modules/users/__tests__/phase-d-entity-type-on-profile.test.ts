import { describe, expect, it } from 'vitest';
import { profilePayload } from '../users.mapper';

/**
 * Phase D (the owner, 1 Oct 2026) — `GET /users/me` hands the party rows out
 * with the legal form as every other read answers it: `entityType` the
 * effective value (the stored one, else what the legacy `type` settles, else
 * null — "ask at the KYC start") and `entityTypeStored`. Without it the same
 * field said null here and INDIVIDUAL on `/publishers/me`.
 */

const user = (over: Record<string, unknown> = {}) =>
  ({
    id: 'usr_1',
    roles: [{ role: 'PUBLISHER' }],
    agentProfile: null,
    publisherProfile: null,
    advertiserProfile: null,
    ...over,
  }) as unknown as Parameters<typeof profilePayload>[0];

describe('the party rows on GET /users/me', () => {
  it('answer the effective legal form and whether it was chosen', () => {
    const payload = profilePayload(
      user({
        publisherProfile: { id: 'pub_1', type: 'INDIVIDUAL', entityType: null, kyc: { status: 'PENDING' } },
        advertiserProfile: { id: 'adv_1', type: 'COMMERCIAL', entityType: 'COMPANY' },
      }),
    );
    expect(payload.publisherProfile).toMatchObject({ id: 'pub_1', entityType: 'INDIVIDUAL', entityTypeStored: false, kyc: { status: 'PENDING' } });
    expect(payload.advertiserProfile).toMatchObject({ id: 'adv_1', entityType: 'COMPANY', entityTypeStored: true });
  });

  it('answer null where the form is still to be asked, and leave a side the account does not have as null', () => {
    const payload = profilePayload(user({ advertiserProfile: { id: 'adv_1', type: 'AGENCY', entityType: null } }));
    expect(payload.advertiserProfile).toMatchObject({ entityType: null, entityTypeStored: false });
    expect(payload.publisherProfile).toBeNull();
  });
});
