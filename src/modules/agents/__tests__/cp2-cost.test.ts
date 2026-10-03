import { describe, expect, it } from 'vitest';
import { costPerOnboarding, salaryCostOverWindow, type SalarySpan } from '../compensation/compensation.rules';

/**
 * CP-2: what a stretch of work cost.
 *
 * The figures below are the owner's own — a ₹12,000 field agent and a
 * ₹25,000 sales agent — and the point of every test is that a month costs a
 * month's salary and nothing else does. Nobody should have to read the
 * implementation to know whether February is cheaper than March.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The UTC instant of a wall-clock time in India, the way every window in this platform is built. */
const ist = (local: string): Date => new Date(Date.parse(`${local}:00.000Z`) - IST_OFFSET_MS);
const month = (from: string, to: string) => ({ start: ist(`${from}T00:00`), end: ist(`${to}T00:00`) });
const span = (monthlySalary: string, from: string, to: string | null = null): SalarySpan => ({
  monthlySalary,
  from: ist(`${from}T00:00`),
  to: to ? ist(`${to}T00:00`) : null,
});

describe('CP-2: the salary a window committed', () => {
  it('costs a full calendar month exactly one month of salary', () => {
    // September has thirty days, and all thirty are inside the window.
    expect(salaryCostOverWindow([span('12000', '2026-01-01')], month('2026-09-01', '2026-10-01'))).toBe('12000.00');
    expect(salaryCostOverWindow([span('25000', '2026-01-01')], month('2026-09-01', '2026-10-01'))).toBe('25000.00');
  });

  it('costs February a month too, rather than making it cheap', () => {
    /* The whole reason a day costs `salary / days in ITS month` rather than a
       flat thirtieth: a 28-day February and a 31-day March both cost one
       month, which is what the agent is actually paid. */
    expect(salaryCostOverWindow([span('12000', '2026-01-01')], month('2026-02-01', '2026-03-01'))).toBe('12000.00');
    expect(salaryCostOverWindow([span('12000', '2026-01-01')], month('2026-03-01', '2026-04-01'))).toBe('12000.00');
  });

  it('charges a part of a month its share of the days', () => {
    // Ten days of a thirty-day September: 12000 / 30 × 10.
    expect(salaryCostOverWindow([span('12000', '2026-01-01')], month('2026-09-01', '2026-09-11'))).toBe('4000.00');
    // A single day.
    expect(salaryCostOverWindow([span('12000', '2026-01-01')], month('2026-09-05', '2026-09-06'))).toBe('400.00');
  });

  it('charges only the days a span was in force, so a mid-month hire costs half a month', () => {
    // Hired on the 16th of a thirty-day month: fifteen days.
    expect(salaryCostOverWindow([span('12000', '2026-09-16')], month('2026-09-01', '2026-10-01'))).toBe('6000.00');
    // Gone on the 16th: the other fifteen.
    expect(salaryCostOverWindow([span('12000', '2026-01-01', '2026-09-16')], month('2026-09-01', '2026-10-01'))).toBe('6000.00');
  });

  it('follows a raise mid-month, each day at the salary in force that day', () => {
    const spans = [span('12000', '2026-01-01', '2026-09-16'), span('25000', '2026-09-16')];
    // Fifteen days at 400 a day, then fifteen at 833.333…
    expect(salaryCostOverWindow(spans, month('2026-09-01', '2026-10-01'))).toBe('18500.00');
  });

  it('costs nothing for the days no span covers, and nothing at all with no spans', () => {
    expect(salaryCostOverWindow([], month('2026-09-01', '2026-10-01'))).toBe('0.00');
    // In force only for the last ten days of the window.
    expect(salaryCostOverWindow([span('12000', '2026-09-21')], month('2026-09-01', '2026-10-01'))).toBe('4000.00');
  });

  it('spans a year end without losing December', () => {
    // 15 days of December (31) plus 15 of January (31), at ₹12,000 a month.
    const cost = salaryCostOverWindow([span('12000', '2026-01-01')], month('2026-12-17', '2027-01-16'));
    expect(cost).toBe('11612.90');
  });

  it('answers zero for a window that closes before it opens', () => {
    expect(salaryCostOverWindow([span('12000', '2026-01-01')], month('2026-10-01', '2026-09-01'))).toBe('0.00');
  });
});

describe('CP-2: the cost of one onboarding', () => {
  it('divides the money by what it bought', () => {
    // A ₹12,000 field agent who onboarded 260 autos in the month.
    expect(costPerOnboarding('12000.00', 260)).toBe('46.15');
    // The same agent at six a day over a 26-day month.
    expect(costPerOnboarding('12000.00', 156)).toBe('76.92');
  });

  it('is null with nothing onboarded, because a zero would read as free', () => {
    expect(costPerOnboarding('12000.00', 0)).toBeNull();
    expect(costPerOnboarding('12000.00', -1)).toBeNull();
  });
});
