import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E7-3: `GET /advertisers?q=` — the roster takes a search beside its cursor
 * page. The handler trims and bounds it; the repository is asked once with
 * the page and the term together.
 */

const repository = vi.hoisted(() => ({ listAdvertisers: vi.fn() }));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../wallets', () => ({ move: vi.fn(), findWallet: vi.fn() }));
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../payouts', () => ({ findPayoutMethod: vi.fn(), recordIncentiveOnce: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentTier: vi.fn() }));
vi.mock('../../agreements', () => ({ acceptInsertionOrder: vi.fn(), isCurrentAcceptance: vi.fn() }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) }));

import { listAdvertisersHandler } from '../advertisers.controller';

const res = () => {
  const out = { body: undefined as unknown };
  return Object.assign(out, { json: vi.fn((body: unknown) => (out.body = body)) });
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.listAdvertisers.mockResolvedValue({ items: [{ id: 'adv_1' }], nextCursor: null });
});

describe('GET /advertisers', () => {
  it('passes q beside the cursor page, trimmed', async () => {
    const response = res();
    await listAdvertisersHandler({ query: { q: '  nilgiri ', limit: '10', cursor: 'adv_0' } } as never, response as never);
    expect(repository.listAdvertisers).toHaveBeenCalledWith({ q: 'nilgiri', limit: 10, cursor: 'adv_0' });
    expect(response.body).toEqual({ success: true, data: { items: [{ id: 'adv_1' }], nextCursor: null } });
  });

  it('asks without q when none is sent or it is blank — the old read, unchanged', async () => {
    await listAdvertisersHandler({ query: { q: '   ' } } as never, res() as never);
    expect(repository.listAdvertisers).toHaveBeenCalledWith({ cursor: undefined, limit: undefined });
  });
});
