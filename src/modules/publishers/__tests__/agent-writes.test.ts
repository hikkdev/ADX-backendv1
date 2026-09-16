import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Attribution reads; authority writes.
 *
 * `Publisher.agentId` records who brought a publisher in, and it used to be
 * the whole permission: whoever claimed them could write to them for ever.
 * Now a write needs a live grant — the one the owner opened by approving the
 * scan, or one they lent later — and every write is recorded against that
 * grant's id. Reading the publisher stays on attribution.
 */

const { repository, agents, grants, audit, pricing } = vi.hoisted(() => ({
  repository: { findById: vi.fn(), findSummaryById: vi.fn(), create: vi.fn(), update: vi.fn(), submitKyc: vi.fn(), pinKycManifestVersion: vi.fn() },
  agents: { findAgentProfile: vi.fn() },
  grants: { liveGrantFor: vi.fn() },
  audit: { logActivity: vi.fn() },
  // Lot X-B: the city key — Bengaluru (and its old spelling) is catalogued; anything else is a typed town.
  pricing: {
    cityKeyFor: vi.fn(async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null)),
    withCityKey: vi.fn(async (data: { city?: string | null }) => (data.city === undefined ? data : { ...data, cityId: (await pricing.cityKeyFor(data.city))?.cityId ?? null })),
  },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../agents', () => agents);
vi.mock('../../access-grants', () => grants);
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../../shared/audit', () => audit);
// Lot F: the manifest pin reads the live flow version when the phone sends none.
vi.mock('../../app-config', () => ({ getFlow: vi.fn(async () => ({ version: 2 })), ONBOARDING_FLOW_KEY: 'onboarding', getPlatformSettings: vi.fn() }));

import { createPublisher, getOwnedPublisher, submitKyc, updatePublisher } from '../publishers.service';

const publisher = { id: 'pub_1', agentId: 'agt_1', kyc: null, listings: [] };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(publisher);
  repository.update.mockImplementation(async (id: string, patch: unknown) => ({ id, ...(patch as object) }));
  repository.submitKyc.mockResolvedValue({ publisherId: 'pub_1' });
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1' });
  grants.liveGrantFor.mockResolvedValue({ id: 'grant_1' });
  audit.logActivity.mockResolvedValue(undefined);
});

describe('reading', () => {
  it('needs only attribution', async () => {
    // E6: the read adds `user` and `openOrders` on the way out, so it is the row plus those;
    // N3-B: and `kyc` is the party's KYC summary — AWAITING_DOCUMENTS with no record.
    await expect(getOwnedPublisher('pub_1', 'usr_agent')).resolves.toEqual({
      ...publisher,
      user: null,
      openOrders: 0,
      kyc: { state: 'AWAITING_DOCUMENTS', kycId: null, status: null, submittedAt: null, requestedAt: null, requestedChannel: null, method: null },
    });
    expect(grants.liveGrantFor).not.toHaveBeenCalled();
  });

  it('is 403 for another agent', async () => {
    agents.findAgentProfile.mockResolvedValue({ id: 'agt_other' });
    await expect(getOwnedPublisher('pub_1', 'usr_other')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('writing', () => {
  it('needs a live PROFILE grant, and records the write against it', async () => {
    await updatePublisher('pub_1', 'usr_agent', { city: 'Bengaluru' });
    expect(grants.liveGrantFor).toHaveBeenCalledWith('agt_1', { publisherId: 'pub_1' }, 'PROFILE');
    // Lot X-B: the city key rides with the typed city.
    expect(repository.update).toHaveBeenCalledWith('pub_1', { city: 'Bengaluru', cityId: 'city_bengaluru' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_agent', 'PUBLISHER_UPDATED_UNDER_GRANT', undefined, {
      publisherId: 'pub_1',
      grantId: 'grant_1',
      fields: ['city'],
    });
  });

  it('is refused without one, even for the agent who brought them in', async () => {
    grants.liveGrantFor.mockResolvedValue(null);
    await expect(updatePublisher('pub_1', 'usr_agent', { city: 'Bengaluru' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(submitKyc('pub_1', 'usr_agent', { govIdType: 'AADHAAR' })).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.submitKyc).not.toHaveBeenCalled();
  });

  it('records a KYC submission the same way', async () => {
    // E9 (the E7 verifier): while NEEDS_INFO a body naming no document field is refused, and nothing is written.
    repository.findById.mockResolvedValue({ ...publisher, kyc: { id: 'kyc_1', status: 'NEEDS_INFO' } });
    await expect(submitKyc('pub_1', 'usr_agent', { govIdType: 'AADHAAR' })).rejects.toMatchObject({ statusCode: 400, code: 'EMPTY_RESUBMISSION' });
    expect(repository.submitKyc).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalledWith('usr_agent', 'PUBLISHER_KYC_SUBMITTED_UNDER_GRANT', undefined, expect.anything());
    repository.findById.mockResolvedValue(publisher);

    await submitKyc('pub_1', 'usr_agent', { govIdType: 'AADHAAR', govIdFrontUrl: 'https://x/a.jpg' });
    // Lot F: the columns go to the row; the manifest version is pinned beside them (the live one, since the phone sent none).
    // Lot N: the agent's hand is stamped on the row.
    expect(repository.submitKyc).toHaveBeenCalledWith('pub_1', { govIdType: 'AADHAAR', govIdFrontUrl: 'https://x/a.jpg' }, { recordedById: 'usr_agent', recordedVia: 'AGENT', method: 'MANUAL' });
    expect(repository.pinKycManifestVersion).toHaveBeenCalledWith('pub_1', 2);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_agent',
      'PUBLISHER_KYC_SUBMITTED_UNDER_GRANT',
      undefined,
      expect.objectContaining({ grantId: 'grant_1', fields: ['govIdType', 'govIdFrontUrl'] }),
    );
  });
});

describe('the city key (Lot X-B)', () => {
  it('a create with the old spelling keys to the catalogue row; a typed town keeps its string with a null key; no city, no key', async () => {
    repository.create.mockImplementation(async (data: unknown) => data);
    const created = await createPublisher({ agentId: 'agt_1', name: 'Sharma', mobile: '+919876543210', city: 'Bangalore' });
    expect(created).toMatchObject({ city: 'Bangalore', cityId: 'city_bengaluru' });
    const typed = await createPublisher({ agentId: null, name: 'Typed', mobile: '+919876543211', city: 'Rameswaram' });
    expect(typed).toMatchObject({ city: 'Rameswaram', cityId: null });
    const none = await createPublisher({ agentId: null, name: 'None', mobile: '+919876543212' });
    expect(none).not.toHaveProperty('cityId');
  });

  it('a patch that does not touch the city leaves the key alone', async () => {
    await updatePublisher('pub_1', 'usr_agent', { name: 'Renamed' });
    expect(repository.update).toHaveBeenCalledWith('pub_1', { name: 'Renamed' });
  });
});
