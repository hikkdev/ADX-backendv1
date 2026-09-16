import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G11-1: `openOrderExposureFor` — the non-terminal orders on a party and
 * what they are worth, as `fraud`'s linked-accounts rail reads it through
 * this module's index. One aggregate per party; the value is money, "0.00"
 * when nothing is open or the orders carry no budget.
 */

const { repository } = vi.hoisted(() => ({
  repository: { countOpenExposure: vi.fn() },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));

import { openOrderExposureFor } from '../orders.queries';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('openOrderExposureFor', () => {
  it('answers the count and the value as money, scoped to the party', async () => {
    repository.countOpenExposure.mockResolvedValue({ count: 3, value: 12500.5 });
    expect(await openOrderExposureFor({ publisherId: 'pub_1' })).toEqual({ count: 3, value: '12500.50' });
    expect(repository.countOpenExposure).toHaveBeenCalledWith({ publisherId: 'pub_1' });

    repository.countOpenExposure.mockResolvedValue({ count: 1, value: 800 });
    expect(await openOrderExposureFor({ advertiserUserId: 'usr_adv' })).toEqual({ count: 1, value: '800.00' });
    expect(repository.countOpenExposure).toHaveBeenLastCalledWith({ advertiserUserId: 'usr_adv' });
  });

  it('is zero with nothing open, or with open orders that carry no budget', async () => {
    repository.countOpenExposure.mockResolvedValue({ count: 0, value: null });
    expect(await openOrderExposureFor({ agentId: 'agt_1' })).toEqual({ count: 0, value: '0.00' });
    repository.countOpenExposure.mockResolvedValue({ count: 2, value: null });
    expect(await openOrderExposureFor({ agentId: 'agt_1' })).toEqual({ count: 2, value: '0.00' });
  });
});
