import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, QUERY, WINDOW_END, WINDOW_START, labelsOf, leadsSeed } from './fixtures';
import { inMemoryRepository } from './in-memory.repository';

/**
 * LH9 (the Lead Hunt, 22 Sep 2026): the Leads overview — aggregates only.
 *
 * Pinned: the tiles against the previous window and the two states; the
 * three day series; the funnel carried as `leads.funnel` answers it over
 * the window's cohort, the stages in the pipeline's order with the
 * pipeline value folded; the conversion by source / agent (labelled) /
 * city (keyed) / category / channel with a rate; the mean and the median
 * time to convert; the cost per activation as (incentives + top-ups) over
 * the catches; the recycle yield; the city filter; the cache key.
 */

const state = vi.hoisted(() => ({
  repository: null as unknown as ReturnType<typeof import('./in-memory.repository').inMemoryRepository>,
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  agents: { findAgentLabels: vi.fn(), getLeaderboardForCity: vi.fn() },
  leads: { leadFunnel: vi.fn(), LEAD_STAGES: ['SOURCED', 'SCORED', 'CLAIMED', 'CONTACTED', 'ENGAGED', 'VISIT_BOOKED', 'PROPOSED', 'CONVERTED', 'ONBOARDING', 'ACTIVATED', 'RETAINED', 'LOST'] },
}));

vi.mock('../prisma-section-overviews.repository', () => ({
  prismaSectionOverviewsRepository: new Proxy({}, { get: (_target, property) => (state.repository as unknown as Record<PropertyKey, unknown>)[property] }),
}));
vi.mock('../../../shared/cache', () => state.cache);
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => {
    const key = (name ?? '').trim().toLowerCase();
    return key === 'bengaluru' || key === 'bangalore' ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : key === 'mumbai' ? { cityId: 'city_mumbai', slug: 'mumbai' } : null;
  },
}));
vi.mock('../../agents', () => state.agents);
vi.mock('../../leads', () => state.leads);
vi.mock('../../supply', () => ({}));
vi.mock('../../advertisers', () => ({}));
vi.mock('../../publishers', () => ({}));
vi.mock('../../employees', () => ({}));
vi.mock('../../print-partners', () => ({}));

import { SECTIONS, sectionOverview, sectionOverviewCacheKey, type LeadsOverview } from '../section-overviews.service';

const FUNNEL = {
  byStage: [
    { stage: 'CONTACTED', count: 2, value: '3000.00', avgDaysInStage: 1.5 },
    { stage: 'CONVERTED', count: 1, value: '5000.00', avgDaysInStage: null },
    { stage: 'ACTIVATED', count: 2, value: null, avgDaysInStage: 3 },
    { stage: 'LOST', count: 1, value: null, avgDaysInStage: 2 },
  ],
  bySource: [
    { key: 'google-places', label: 'Google Places', total: 3, converted: 2, activated: 1 },
    { key: 'none', label: 'No source', total: 1, converted: 0, activated: 0 },
  ],
  byAgent: [{ key: 'agt_1', total: 3, converted: 2, activated: 2 }],
  byCity: [{ key: 'Bengaluru', total: 3, converted: 2, activated: 2 }],
  byCategory: [{ key: 'Wall', total: 4, converted: 2, activated: 2 }],
  byChannel: [{ channel: 'WHATSAPP', firstContact: 2, engaged: 1, converted: 1 }, { channel: 'IN_PERSON', firstContact: 1, engaged: 1, converted: 1 }],
  lossMix: [{ reason: 'PRICE', count: 1 }],
  avgDaysToConvert: 3.5,
  totals: { leads: 4, converted: 2, activated: 2, retained: 0, lost: 1, recycled: 0 },
};

const read = (query: { from?: string; to?: string; city?: string } = QUERY) => {
  state.repository = inMemoryRepository(leadsSeed());
  return sectionOverview('leads', query, NOW) as Promise<LeadsOverview>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  state.agents.findAgentLabels.mockImplementation(labelsOf);
  state.leads.leadFunnel.mockResolvedValue(FUNNEL);
});

describe('the leads overview', () => {
  it('is the seventh section', () => {
    expect(SECTIONS).toContain('leads');
  });

  it('counts the window against the one before, and the two states as states', async () => {
    const { tiles } = await read();
    // Four created in the window (one on the seam at 00:15 IST on the 1st), three before (one at 23:30 IST on the 31st).
    expect(tiles.newInWindow).toEqual({ value: 4, previous: 3, delta: 1 });
    expect(tiles.contacted).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(tiles.converted).toEqual({ value: 3, previous: 1, delta: 2 });
    expect(tiles.activated).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(tiles.lost).toEqual({ value: 1, previous: 1, delta: 0 });
    expect(tiles.open).toEqual({ value: 12, previous: null, delta: null });
    expect(tiles.byTemperature.items.map((row) => [row.key, row.label, row.count, row.href])).toEqual([
      ['HOT', 'Hot', 3, '/leads/list?temperature=HOT'],
      ['WARM', 'Warm', 5, '/leads/list?temperature=WARM'],
      ['COLD', 'Cold', 4, '/leads/list?temperature=COLD'],
    ]);
  });

  it('draws the three series over every Indian day, zeros filled, the previous window beside them', async () => {
    const { series } = await read();
    expect(series.newLeads.days).toHaveLength(10);
    expect(series.newLeads.days.map((point) => point.value)).toEqual([1, 0, 1, 0, 0, 1, 0, 0, 0, 1]);
    expect(series.newLeads.previous).toHaveLength(10);
    expect(series.newLeads.total).toEqual({ value: 4, previous: 3, delta: 1 });
    expect(series.conversions.days.map((point) => point.value)).toEqual([0, 0, 1, 0, 0, 0, 0, 1, 1, 0]);
    expect(series.activations.total).toEqual({ value: 2, previous: 1, delta: 1 });
  });

  it("carries the funnel as leads answers it over the window's cohort, the stages in order with the pipeline value folded", async () => {
    const { funnel, conversion } = await read();
    expect(state.leads.leadFunnel).toHaveBeenCalledWith({ from: WINDOW_START, to: new Date(WINDOW_END.getTime() - 1) });
    expect(funnel.byStage.map((row) => row.key)).toEqual(['SOURCED', 'SCORED', 'CLAIMED', 'CONTACTED', 'ENGAGED', 'VISIT_BOOKED', 'PROPOSED', 'CONVERTED', 'ONBOARDING', 'ACTIVATED', 'RETAINED', 'LOST']);
    expect(funnel.byStage.find((row) => row.key === 'CONTACTED')).toEqual({ key: 'CONTACTED', label: 'Contacted', count: 2, value: '3000.00', avgDaysInStage: 1.5 });
    expect(funnel.byStage.find((row) => row.key === 'SOURCED')).toEqual({ key: 'SOURCED', label: 'Sourced', count: 0, value: null, avgDaysInStage: null });
    expect(conversion.pipelineValue).toBe('8000.00');
    expect(funnel.totals.leads).toBe(4);
    expect(funnel.lossMix).toEqual([{ reason: 'PRICE', count: 1 }]);
  });

  it('breaks the conversion down by source, agent (labelled), city (keyed), category and channel, each with its rate', async () => {
    const { breakdowns } = await read();
    expect(breakdowns.bySource.items).toEqual([
      { key: 'google-places', label: 'Google Places', href: '/leads/sources?key=google-places', leads: 3, converted: 2, activated: 1, ratePct: '66.67' },
      { key: 'none', label: 'No source', href: null, leads: 1, converted: 0, activated: 0, ratePct: '0.00' },
    ]);
    expect(breakdowns.byAgent.items).toEqual([{ key: 'agt_1', label: 'Name agt_1', displayId: 'D-agt_1', href: '/agents/agt_1', leads: 3, converted: 2, activated: 2, ratePct: '66.67' }]);
    // The city rows are the repository's own, keyed: leads created in the window and how many converted.
    expect(breakdowns.byCity.items.map((row) => [row.key, row.label, row.href, row.count, row.converted, row.ratePct])).toEqual([
      ['bengaluru', 'Bengaluru', '/leads?city=bengaluru', 3, 2, '66.67'],
      ['mumbai', 'Mumbai', '/leads?city=mumbai', 1, 0, '0.00'],
    ]);
    expect(breakdowns.byCategory.items[0]).toEqual({ key: 'Wall', label: 'Wall', href: '/leads/list?category=Wall', leads: 4, converted: 2, activated: 2, ratePct: '50.00' });
    expect(breakdowns.byChannel.items).toEqual([
      { key: 'WHATSAPP', label: 'WhatsApp', href: null, firstContact: 2, engaged: 1, converted: 1 },
      { key: 'IN_PERSON', label: 'In person', href: null, firstContact: 1, engaged: 1, converted: 1 },
    ]);
  });

  it('prints the time to convert as a mean and a median, null when nothing converted', async () => {
    const { conversion } = await read();
    // 2, 5 and 10 days this window; 4 the window before.
    expect(conversion.timeToConvert).toEqual({ meanDays: 5.7, medianDays: 5, previousMeanDays: 4, previousMedianDays: 4 });
    const empty = await read({ from: '2026-07-01', to: '2026-07-10' });
    expect(empty.conversion.timeToConvert).toEqual({ meanDays: null, medianDays: null, previousMeanDays: null, previousMedianDays: null });
  });

  it('costs an activation at the recorded rewards plus the top-ups over the catches, and says the money', async () => {
    const { conversion, money } = await read();
    // (100 + 500 + 500 + 200) / 2 this window; 100 / 1 before.
    expect(conversion.costPerActivation).toEqual({ value: '650.00', previous: '100.00', incentives: '1100.00', topUps: '200.00', activations: 2 });
    expect(money.incentives).toEqual({ value: '1100.00', previous: '100.00', delta: '1000.00' });
    expect(money.topUps).toEqual({ value: '200.00', previous: '0.00', delta: '200.00' });
    const empty = await read({ from: '2026-07-01', to: '2026-07-10' });
    expect(empty.conversion.costPerActivation.value).toBeNull();
  });

  it('yields the recycle: of the leads recycled in the window, how many have converted since', async () => {
    const { recycle } = await read();
    // led_r and led_d recycled this window; led_r converted on the 9th, led_d not yet. led_x recycled the window before, never converted.
    expect(recycle).toEqual({ recycled: { value: 2, previous: 1, delta: 1 }, convertedAfterRecycle: { value: 1, previous: 0, delta: 1 }, yieldPct: '50.00' });
  });

  it('narrows to a city and hands the funnel the same spelling', async () => {
    const mumbai = await read({ ...QUERY, city: 'Mumbai' });
    expect(mumbai.city).toBe('Mumbai');
    expect(mumbai.tiles.newInWindow.value).toBe(1);
    expect(mumbai.tiles.lost.value).toBe(1);
    expect(state.leads.leadFunnel).toHaveBeenCalledWith(expect.objectContaining({ city: 'Mumbai' }));
    expect(mumbai.breakdowns.byCity.items.map((row) => row.key)).toEqual(['mumbai']);
  });

  it('reads through the cache under the section, the window and the city', async () => {
    await read({ ...QUERY, city: 'Bengaluru' });
    expect(state.cache.readThrough).toHaveBeenCalledWith(sectionOverviewCacheKey('leads', '2026-09-01', '2026-09-10', 'Bengaluru'), 60, expect.any(Function));
    expect(sectionOverviewCacheKey('leads', '2026-09-01', '2026-09-10', undefined)).toBe('section-overviews:leads:2026-09-01:2026-09-10:-');
  });
});
