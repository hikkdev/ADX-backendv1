import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The nightly quote-request expiry job — Lot H (Q147).
 *
 * What is pinned: the tick heartbeats, takes the tick lock, runs once per
 * Indian day (the day key), hands the work to the module's
 * `expireQuoteRequests`, and logs rather than throws when that fails.
 */

const { redis, jobs, printPartners, logging } = vi.hoisted(() => ({
  redis: { redis: { set: vi.fn(), hset: vi.fn() } },
  jobs: { recordHeartbeat: vi.fn() },
  printPartners: { expireQuoteRequests: vi.fn() },
  logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/jobs', () => jobs);
vi.mock('../../../shared/logging', () => logging);
vi.mock('../../../shared/errors', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('../../print-partners', () => printPartners);

import { printQuoteExpiryTick } from '../../../jobs/print-quote-expiry.job';

const NOW = new Date('2026-09-14T21:30:00Z'); // 03:00 IST on the 15th

beforeEach(() => {
  vi.clearAllMocks();
  redis.redis.set.mockResolvedValue('OK');
  printPartners.expireQuoteRequests.mockResolvedValue({ checked: 1, reinvited: ['req_1'], expired: [], awaitingAward: [] });
});

describe('the print quote expiry tick', () => {
  it('heartbeats, locks the tick and the Indian day, and runs the expiry once', async () => {
    await printQuoteExpiryTick(NOW);
    expect(jobs.recordHeartbeat).toHaveBeenCalledWith('print-quote-expiry', NOW);
    expect(redis.redis.set).toHaveBeenNthCalledWith(1, 'lock:print-quote-expiry-tick', '1', 'PX', 50 * 60 * 1000, 'NX');
    expect(redis.redis.set).toHaveBeenNthCalledWith(2, 'lock:print-quote-expiry:2026-09-15', '1', 'EX', 36 * 60 * 60, 'NX');
    expect(printPartners.expireQuoteRequests).toHaveBeenCalledWith(NOW);
    expect(logging.logger.info).toHaveBeenCalledWith('Print quote requests expired', expect.objectContaining({ reinvited: ['req_1'] }));
  });

  it('does nothing when another instance holds the tick, or the day has already run', async () => {
    redis.redis.set.mockResolvedValueOnce(null);
    await printQuoteExpiryTick(NOW);
    expect(printPartners.expireQuoteRequests).not.toHaveBeenCalled();

    redis.redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await printQuoteExpiryTick(NOW);
    expect(printPartners.expireQuoteRequests).not.toHaveBeenCalled();
    expect(jobs.recordHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('logs a failure rather than throwing', async () => {
    printPartners.expireQuoteRequests.mockRejectedValueOnce(new Error('db away'));
    await expect(printQuoteExpiryTick(NOW)).resolves.toBeUndefined();
    expect(logging.logger.error).toHaveBeenCalledWith('printQuoteExpiryJob tick failed', expect.objectContaining({ tag: 'printQuoteExpiryJob' }));
  });
});
