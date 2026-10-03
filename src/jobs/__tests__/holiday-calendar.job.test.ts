import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * HC-1 (1 Oct 2026) — the weekly holiday calendar job.
 *
 * What is pinned: the week begins Monday 03:00 IST; the hourly tick runs
 * the sync once per week (the week key) through `hr`'s scheduled run,
 * which itself does nothing while the calendar is off; with Redis away the
 * tick is skipped rather than run unlocked; and a failure is reported, not
 * thrown. Every tick records its heartbeat.
 */

const { redis, hr, heartbeat, errors } = vi.hoisted(() => ({
  redis: { set: vi.fn() },
  hr: { runScheduledHolidaySync: vi.fn() },
  heartbeat: { recordHeartbeat: vi.fn() },
  errors: { reportError: vi.fn() },
}));

vi.mock('../../shared/cache', () => ({
  redis,
  orSkipWhenRedisDown: async <T>(call: Promise<T>) => {
    try {
      return await call;
    } catch {
      return null;
    }
  },
}));
vi.mock('../../modules/hr', () => hr);
vi.mock('../../shared/jobs', () => heartbeat);
vi.mock('../../shared/errors', () => errors);

import { holidayCalendarTick, holidayWeekKey } from '../holiday-calendar.job';

beforeEach(() => {
  vi.clearAllMocks();
  hr.runScheduledHolidaySync.mockResolvedValue({ added: 3, updated: 1, adopted: 0, skipped: 0, years: [2026, 2027] });
});

describe('the holiday calendar week', () => {
  it('begins Monday 03:00 IST', () => {
    // Monday 5 Oct 2026, 02:59 IST = Sunday 21:29 UTC — still the week of Monday 28 Sep.
    expect(holidayWeekKey(new Date('2026-10-04T21:29:00.000Z'))).toBe('2026-09-28');
    // Monday 5 Oct 2026, 03:00 IST = Sunday 21:30 UTC — the new week.
    expect(holidayWeekKey(new Date('2026-10-04T21:30:00.000Z'))).toBe('2026-10-05');
  });
});

describe('holidayCalendarTick', () => {
  it('runs the sync the first tick of the week, and records its heartbeat', async () => {
    redis.set.mockResolvedValue('OK');
    await holidayCalendarTick(new Date('2026-10-04T22:00:00.000Z'));
    expect(hr.runScheduledHolidaySync).toHaveBeenCalledWith(new Date('2026-10-04T22:00:00.000Z'));
    expect(redis.set).toHaveBeenCalledWith('lock:holiday-calendar:2026-10-05', '1', 'EX', expect.any(Number), 'NX');
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith('holiday-calendar', expect.any(Date));
  });

  it('does not run twice in a week', async () => {
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await holidayCalendarTick(new Date('2026-10-06T10:00:00.000Z'));
    expect(hr.runScheduledHolidaySync).not.toHaveBeenCalled();
  });

  it('skips the tick when Redis is away', async () => {
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    await holidayCalendarTick(new Date('2026-10-06T10:00:00.000Z'));
    expect(hr.runScheduledHolidaySync).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).toHaveBeenCalled();
  });

  it('reports a failure instead of throwing', async () => {
    redis.set.mockResolvedValue('OK');
    hr.runScheduledHolidaySync.mockRejectedValue(new Error('relation does not exist'));
    await expect(holidayCalendarTick(new Date('2026-10-06T10:00:00.000Z'))).resolves.toBeUndefined();
    expect(errors.reportError).toHaveBeenCalled();
  });
});
