import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 06 — the agent's publisher book. Revenue is suppressed (null, not zero)
 * while KYC is pending; the category chip is the listings' categories,
 * because a publisher has none of its own.
 */

const { repository } = vi.hoisted(() => ({ repository: { findBook: vi.fn(), facts: vi.fn() } }));
vi.mock('../book/prisma-publisher-book.repository', () => ({ prismaPublisherBookRepository: repository }));

import { Decimal } from '../../../shared/money';
import { publisherBook } from '../book/publisher-book.service';
import { publisherBookQuerySchema } from '../book/publisher-book.schema';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  displayId: 'PUB-0101-2601',
  name: 'Suraj Kumar Prints',
  mobile: '+919800000002',
  city: 'Bengaluru',
  address: 'Koramangala',
  kycStatus: 'VERIFIED',
  onboardingStatus: 'ONBOARDING_COMPLETE',
  activatedAt: new Date('2026-06-01T00:00:00.000Z'),
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findBook.mockResolvedValue({ items: [publisher(), publisher({ id: 'pub_2', name: 'Blue Tokai Cafe', kycStatus: 'PENDING' })], total: 2, counts: { ACTIVE: 1, PENDING: 1 } });
  repository.facts.mockResolvedValue(
    new Map([
      ['pub_1', { listings: 4, categories: ['INDOOR', 'OUTDOOR'], revenue: new Decimal('45200.00') }],
      ['pub_2', { listings: 1, categories: ['INDOOR'], revenue: new Decimal('800.00') }],
    ]),
  );
});

describe('the publisher book', () => {
  it('prints listings and revenue to date as money, and suppresses revenue while KYC is pending', async () => {
    const page = await publisherBook('agt_1', publisherBookQuerySchema.parse({}));
    expect(page.total).toBe(2);
    expect(page.counts).toEqual({ ACTIVE: 1, PENDING: 1 });
    expect(page.items[0]).toMatchObject({ name: 'Suraj Kumar Prints', active: true, listings: 4, categories: ['INDOOR', 'OUTDOOR'], revenueToDate: '45200.00' });
    expect(page.items[1]).toMatchObject({ name: 'Blue Tokai Cafe', active: false, listings: 1, revenueToDate: null });
  });

  it('sorts by revenue over the page with the suppressed ones last', async () => {
    const page = await publisherBook('agt_1', publisherBookQuerySchema.parse({ sort: 'REVENUE_DESC' }));
    expect(page.items.map((row) => row.name)).toEqual(['Suraj Kumar Prints', 'Blue Tokai Cafe']);
  });
});
