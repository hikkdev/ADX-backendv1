import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q119): the advertiser's industry.
 *
 * What is pinned: `GET /advertisers/industries` is the picklist, a constant
 * list in code; the register and the profile patch accept `industry` only
 * from that list (the patch may clear it); and the row carries it to the
 * repository on both writes.
 */

const repository = vi.hoisted(() => ({
  findUserMobile: vi.fn(),
  findAdvertiserByMobile: vi.fn(),
  createAdvertiser: vi.fn(),
  ensureWallet: vi.fn(),
  createBrand: vi.fn(),
  findAdvertiserById: vi.fn(),
  updateAdvertiser: vi.fn(),
}));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn(async () => 'ADV-1309-2601') }));
vi.mock('../../wallets', () => ({ move: vi.fn(), findWallet: vi.fn() }));
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../payouts', () => ({ findPayoutMethod: vi.fn(), recordIncentiveOnce: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
vi.mock('../../agreements', () => ({ acceptInsertionOrder: vi.fn(), isCurrentAcceptance: vi.fn() }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) }));

import { industriesHandler } from '../advertisers.controller';
import { ADVERTISER_INDUSTRIES, registerAdvertiserSchema, updateProfileSchema } from '../advertisers.schema';
import { registerAdvertiser, updateProfile } from '../advertisers.service';

const res = () => {
  const out = { body: undefined as unknown };
  return Object.assign(out, { json: vi.fn((body: unknown) => (out.body = body)) });
};

const advertiser = (over: Record<string, unknown> = {}) => ({
  id: 'adv_1',
  name: 'Nilgiri Foods',
  mobile: '9845012210',
  type: 'COMMERCIAL',
  companyName: 'Nilgiri Foods Pvt Ltd',
  industry: 'Food & beverage',
  kycStatus: 'PENDING',
  activatedAt: null,
  userId: 'usr_1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findUserMobile.mockResolvedValue('9845012210');
  repository.findAdvertiserByMobile.mockResolvedValue(null);
  repository.createAdvertiser.mockImplementation(async (input: Record<string, unknown>) => advertiser(input));
  repository.ensureWallet.mockResolvedValue(undefined);
  repository.createBrand.mockResolvedValue(undefined);
  repository.findAdvertiserById.mockResolvedValue(advertiser());
  repository.updateAdvertiser.mockImplementation(async (_id: string, patch: Record<string, unknown>) => advertiser(patch));
});

describe('GET /advertisers/industries', () => {
  it('is the picklist, in the order the console draws it', async () => {
    const response = res();
    await industriesHandler({} as never, response as never);
    expect(response.body).toEqual({ success: true, data: [...ADVERTISER_INDUSTRIES] });
    expect(ADVERTISER_INDUSTRIES).toEqual(['Retail', 'Food & beverage', 'Real estate', 'Education', 'Healthcare', 'Automotive', 'Finance', 'Entertainment', 'E-commerce', 'Government', 'NGO', 'Other']);
  });
});

describe('industry on the schemas', () => {
  it('is accepted from the list only, on register and on the profile patch; the patch may clear it', () => {
    expect(registerAdvertiserSchema.parse({ name: 'Nilgiri Foods', industry: 'Retail' }).industry).toBe('Retail');
    expect(registerAdvertiserSchema.safeParse({ name: 'Nilgiri Foods', industry: 'Space travel' }).success).toBe(false);
    expect(updateProfileSchema.parse({ industry: 'E-commerce' })).toEqual({ industry: 'E-commerce' });
    expect(updateProfileSchema.parse({ industry: null })).toEqual({ industry: null });
    expect(updateProfileSchema.safeParse({ industry: 'retail' }).success).toBe(false);
  });

  it('reaches the row on create and on update, and comes back on the read', async () => {
    const created = await registerAdvertiser({ name: 'Nilgiri Foods', type: 'COMMERCIAL', companyName: 'Nilgiri Foods Pvt Ltd', industry: 'Food & beverage', userId: 'usr_1', agentId: null });
    expect(repository.createAdvertiser).toHaveBeenCalledWith(expect.objectContaining({ industry: 'Food & beverage', displayId: 'ADV-1309-2601' }));
    expect(created.industry).toBe('Food & beverage');

    const updated = await updateProfile('adv_1', { industry: 'Retail' });
    expect(repository.updateAdvertiser).toHaveBeenCalledWith('adv_1', { industry: 'Retail' });
    expect(updated.industry).toBe('Retail');
  });
});
