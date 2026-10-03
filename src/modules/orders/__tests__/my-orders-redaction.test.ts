import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 26 Sep 2026: `GET /orders/my` answered `completionOtpPlain` (and the hash)
 * on every row — to the publisher, the advertiser and the agent, who is the
 * one meant to hear it from the publisher. The persona lists drop both.
 */

const { repository, port } = vi.hoisted(() => ({
  repository: { findForPublisherUser: vi.fn(), findForAdvertiser: vi.fn(), findForAgent: vi.fn() },
  port: { pickupsFor: vi.fn(async () => new Map()) },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../print-job.port', () => ({ printJobPort: () => port }));

import { getOrdersForAdvertiser, getOrdersForAgent, getOrdersForPublisher } from '../orders.queries';

const row = { id: 'ord_1', status: 'PENDING_OTP', quotedFee: null, completionOtp: '$2a$hash', completionOtpPlain: '482913', completionOtpExpiry: null };
const query = { page: 1, pageSize: 20 } as never;

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [repository.findForPublisherUser, repository.findForAdvertiser, repository.findForAgent]) {
    fn.mockResolvedValue({ items: [row], total: 1, counts: {} });
  }
});

describe('the persona lists carry no completion code', () => {
  it.each([
    ['publisher', () => getOrdersForPublisher('usr_pub', query)],
    ['advertiser', () => getOrdersForAdvertiser('usr_adv', query)],
    ['agent', () => getOrdersForAgent('agt_1', query)],
  ])('%s', async (_who, read) => {
    const page = (await read()) as { items: Record<string, unknown>[] };
    expect(page.items[0]).toMatchObject({ id: 'ord_1', status: 'PENDING_OTP' });
    expect(page.items[0]).not.toHaveProperty('completionOtpPlain');
    expect(page.items[0]).not.toHaveProperty('completionOtp');
  });
});
