import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot D (Q7/Q139): what happens after the scan.
 *
 * The landing page reports views, CTA presses and form submissions back to
 * the code that brought the visitor. Each is a row ADX wrote itself, stamped
 * with the IST hour and the CTA's label; bots are not counted; and the
 * analytics panel folds them four ways as MEASURED while demographics stay
 * UNAVAILABLE — nothing backs them.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findTrackingCode: vi.fn(),
    recordTrackingEvent: vi.fn(),
    trackingTotals: vi.fn(),
    eventTotalsByDay: vi.fn(),
    interactionTotals: vi.fn(),
    // E11-2: the stored rows the previous-window comparison reads; none here.
    dailyMetricsFor: vi.fn(async () => []),
  },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));

import { hourIst, recordInteraction } from '../tracking.service';
import { campaignAnalytics } from '../analytics.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findTrackingCode.mockResolvedValue({ id: 'code_1', code: 'AB23CD45', destination: null, campaign: { id: 'cmp_1', status: 'LIVE' } });
  repository.recordTrackingEvent.mockResolvedValue(undefined);
});

describe('the IST hour', () => {
  it('is the wall-clock hour in India, whatever the server runs on', () => {
    expect(hourIst(new Date('2026-04-01T18:45:00Z'))).toBe(0); // 00:15 IST next day
    expect(hourIst(new Date('2026-04-01T04:00:00Z'))).toBe(9); // 09:30 IST
    expect(hourIst(new Date('2026-04-01T13:29:00Z'))).toBe(18); // 18:59 IST
  });
});

describe('recording an interaction', () => {
  const phone = { userAgent: 'Mozilla/5.0 (iPhone)', referer: null, city: 'Bengaluru' };

  it('writes the event with the hour, the device class and the CTA label', async () => {
    const result = await recordInteraction('AB23CD45', { type: 'CTA_CLICK', ctaLabel: 'Book a table' }, phone, new Date('2026-04-01T04:00:00Z'));
    expect(result).toEqual({ counted: true });
    expect(repository.recordTrackingEvent).toHaveBeenCalledWith({
      codeId: 'code_1',
      type: 'CTA_CLICK',
      city: 'Bengaluru',
      device: 'mobile',
      referer: null,
      hourIst: 9,
      ctaLabel: 'Book a table',
    });
  });

  it('keeps the label only on a CTA press', async () => {
    await recordInteraction('AB23CD45', { type: 'VIEW', ctaLabel: 'ignored' }, phone);
    expect(repository.recordTrackingEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'VIEW', ctaLabel: null }));
  });

  it('does not count a bot', async () => {
    const result = await recordInteraction('AB23CD45', { type: 'VIEW' }, { userAgent: 'WhatsApp link preview bot', referer: null, city: null });
    expect(result).toEqual({ counted: false });
    expect(repository.recordTrackingEvent).not.toHaveBeenCalled();
  });

  it('404s an unknown code', async () => {
    repository.findTrackingCode.mockResolvedValue(null);
    await expect(recordInteraction('NOPE', { type: 'VIEW' }, phone)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the analytics panel', () => {
  const campaign = () =>
    ({
      id: 'cmp_1',
      reference: 'ADX-CMP-2026-482913',
      name: 'Anita coffee, April',
      status: 'LIVE',
      startDate: new Date('2026-04-01T00:00:00Z'),
      endDate: new Date('2026-04-14T00:00:00Z'),
      budget: null,
      total: new Decimal('34810'),
      trackingMethod: 'QR_OR_DEEPLINK',
      spots: [],
      codes: [{ id: 'code_1', spotId: 'spt_1', method: 'QR_OR_DEEPLINK', scans: 3, clicks: 0, redemptions: 0 }],
    }) as never;

  beforeEach(() => {
    repository.trackingTotals.mockResolvedValue({ scans: 3, clicks: 0, redemptions: 0 });
    repository.eventTotalsByDay.mockResolvedValue([]);
    repository.interactionTotals.mockResolvedValue({
      byDevice: [{ device: 'mobile', count: 5 }],
      byHour: [{ hourIst: 9, count: 2 }, { hourIst: 18, count: 3 }],
      byCity: [{ city: 'Bengaluru', count: 5 }],
      byCta: [{ ctaLabel: 'Book a table', count: 2 }],
    });
  });

  it('reports the interactions as MEASURED, folded four ways', async () => {
    const analytics = await campaignAnalytics(campaign(), new Date('2026-04-05T10:00:00Z'));
    expect(analytics.interactions).toMatchObject({
      provenance: 'MEASURED',
      byDevice: [{ device: 'mobile', count: 5 }],
      byHour: [{ hourIst: 9, count: 2 }, { hourIst: 18, count: 3 }],
      byCity: [{ city: 'Bengaluru', count: 5 }],
      byCta: [{ ctaLabel: 'Book a table', count: 2 }],
    });
  });

  it('keeps demographics UNAVAILABLE — nothing backs them', async () => {
    const analytics = await campaignAnalytics(campaign(), new Date('2026-04-05T10:00:00Z'));
    expect(analytics.demographics).toMatchObject({ value: null, provenance: 'UNAVAILABLE' });
  });

  it('skips the four queries for the portfolio fold', async () => {
    await campaignAnalytics(campaign(), new Date('2026-04-05T10:00:00Z'), { interactions: false });
    expect(repository.interactionTotals).not.toHaveBeenCalled();
  });
});
