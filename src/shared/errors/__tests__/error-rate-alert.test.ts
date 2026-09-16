import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
  set: vi.fn(),
  // E6: the daily history hash.
  hincrby: vi.fn(),
  hgetall: vi.fn(),
  hdel: vi.fn(),
}));

vi.mock('../../cache/redis', () => ({ redis }));

import {
  SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE,
  recordServerError,
  registerServerErrorAlertPort,
} from '../error-rate-alert';

const alert = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  redis.expire.mockResolvedValue(1);
  redis.set.mockResolvedValue('OK');
  alert.mockResolvedValue(undefined);
  registerServerErrorAlertPort({ alertAdmins: alert });
});

const sample = { requestId: 'req-9', path: '/api/v1/orders', status: 500, code: 'INTERNAL_ERROR' };

describe('5xx rate alert', () => {
  it('counts per minute and stays quiet under the threshold', async () => {
    redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE - 1);
    await recordServerError(sample);
    await recordServerError(sample);
    expect(redis.incr).toHaveBeenCalledWith(expect.stringMatching(/^errors:5xx:\d+$/));
    // The window expires on its own: the TTL is set once, by whoever opened it.
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('alerts admins once the minute crosses the threshold', async () => {
    redis.incr.mockResolvedValue(SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE);
    await recordServerError(sample);
    expect(redis.set).toHaveBeenCalledWith('errors:5xx:alerted', '1', 'EX', 15 * 60, 'NX');
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ count: SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE, sample }),
    );
  });

  /* The lock is the throttle: the second instance, or the next minute, loses the SET NX. */
  it('alerts at most once per fifteen minutes', async () => {
    redis.incr.mockResolvedValue(SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE + 5);
    redis.set.mockResolvedValue(null);
    await recordServerError(sample);
    expect(alert).not.toHaveBeenCalled();
  });

  it('never throws — a Redis outage during an outage must not compound it', async () => {
    redis.incr.mockRejectedValue(new Error('redis down'));
    await expect(recordServerError(sample)).resolves.toBeUndefined();
  });

  it('swallows a failing port for the same reason', async () => {
    redis.incr.mockResolvedValue(SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE);
    alert.mockRejectedValue(new Error('notifications down'));
    await expect(recordServerError(sample)).resolves.toBeUndefined();
  });

  it('is a no-op when no port is registered', async () => {
    registerServerErrorAlertPort(null);
    redis.incr.mockResolvedValue(SERVER_ERROR_ALERT_THRESHOLD_PER_MINUTE);
    await expect(recordServerError(sample)).resolves.toBeUndefined();
    expect(alert).not.toHaveBeenCalled();
  });
});

/* E6: the 30-day history the ops page reads. */
describe('daily 5xx history', () => {
  it('counts each error under its IST day and reads the window back oldest first, dropping older fields', async () => {
    const { readDailyServerErrors, istDayKey, DAILY_5XX_KEY } = await import('../error-rate-alert');
    redis.incr.mockResolvedValue(1);
    await recordServerError(sample);
    expect(redis.hincrby).toHaveBeenCalledWith(DAILY_5XX_KEY, istDayKey(new Date()), 1);

    // 20:00 UTC on 12 Sep is 01:30 IST on the 13th.
    const now = new Date('2026-09-12T20:00:00Z');
    expect(istDayKey(now)).toBe('2026-09-13');
    redis.hgetall.mockResolvedValue({ '2026-09-13': '4', '2026-09-11': '2', '2026-07-01': '9' });
    const window = await readDailyServerErrors(now, 3);
    expect(window).toEqual([
      { day: '2026-09-11', count: 2 },
      { day: '2026-09-12', count: 0 },
      { day: '2026-09-13', count: 4 },
    ]);
    expect(redis.hdel).toHaveBeenCalledWith(DAILY_5XX_KEY, '2026-07-01');
  });
});
