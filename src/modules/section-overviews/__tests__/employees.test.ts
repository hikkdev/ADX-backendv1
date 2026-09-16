import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, QUERY, employeesSeed } from './fixtures';
import { inMemoryRepository } from './in-memory.repository';

/** O-B: the employees overview — `GET /employees/overview` and the workload carried through the employees export, the joins and holidays against the previous window, the breakdowns, and the cache key. */

const state = vi.hoisted(() => ({
  repository: null as unknown as ReturnType<typeof import('./in-memory.repository').inMemoryRepository>,
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  employees: { employeesOverview: vi.fn(), workloadReport: vi.fn() },
}));

vi.mock('../prisma-section-overviews.repository', () => ({
  prismaSectionOverviewsRepository: new Proxy({}, { get: (_target, property) => (state.repository as unknown as Record<PropertyKey, unknown>)[property] }),
}));
vi.mock('../../../shared/cache', () => state.cache);
// Lot X-B: `?city=` resolves once through pricing — Bengaluru and Mumbai are catalogued (by name or slug), anything else is a typed town.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => {
    const key = (name ?? '').trim().toLowerCase();
    return key === 'bengaluru' || key === 'bangalore' ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : key === 'mumbai' ? { cityId: 'city_mumbai', slug: 'mumbai' } : null;
  },
}));

vi.mock('../../employees', () => state.employees);
vi.mock('../../supply', () => ({}));
vi.mock('../../advertisers', () => ({}));
vi.mock('../../publishers', () => ({}));
vi.mock('../../agents', () => ({}));
vi.mock('../../print-partners', () => ({}));

import { SECTION_OVERVIEW_CACHE_SECONDS, sectionOverview, sectionOverviewCacheKey, type EmployeesOverviewSection } from '../section-overviews.service';

const OVERVIEW = { headcount: { total: 4, active: 4, inactive: 0 }, openPositions: 1 };
const WORKLOAD = { from: '2026-09-01', to: '2026-09-10', granularity: 'month', thresholds: { medium: 20, high: 50 }, weights: {}, buckets: [], employees: [] };

const read = (query: { from?: string; to?: string; city?: string } = QUERY) => {
  state.repository = inMemoryRepository(employeesSeed());
  return sectionOverview('employees', query, NOW) as Promise<EmployeesOverviewSection>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  state.employees.employeesOverview.mockResolvedValue(OVERVIEW);
  state.employees.workloadReport.mockResolvedValue(WORKLOAD);
});

describe('the employees overview', () => {
  it('carries the employees module\'s own overview and workload rather than re-deriving them', async () => {
    const result = await read();
    expect(result.overview).toEqual(OVERVIEW);
    expect(result.workload).toEqual(WORKLOAD);
    expect(state.employees.employeesOverview).toHaveBeenCalledTimes(1);
    expect(state.employees.workloadReport).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-10', granularity: 'month' }, NOW);
  });

  it('counts joins and holidays against the previous window', async () => {
    const { tiles } = await read();
    expect(tiles.joined).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(tiles.holidays).toEqual({ value: 1, previous: 1, delta: 0 });
    expect(tiles.kyc).toEqual({ awaitingDocuments: 1, requested: 1, pending: 0, needsInfo: 0, rejected: 0, verified: 2 });
    expect(tiles.tenure).toEqual({ under1y: 2, from1to3y: 1, over3y: 1 });
  });

  it('answers the breakdowns on the list contract', async () => {
    const { breakdowns } = await read();
    expect(breakdowns.byDepartment).toMatchObject({ total: 1, page: 1, pageSize: 100, counts: {} });
    expect(breakdowns.byDepartment.items[0]).toEqual({ key: 'dep_ops', label: 'Operations', href: '/hr/departments/dep_ops', headcount: 4, openRoles: 1 });
    expect(breakdowns.byWorkMode.items.map((row) => [row.key, row.label, row.count])).toEqual([['OFFICE', 'Office', 3], ['HYBRID', 'Hybrid', 1]]);
    expect(breakdowns.byEmploymentType.items[0]).toMatchObject({ key: 'FULL_TIME', label: 'Full Time', count: 4 });
    expect(breakdowns.byRegion.items[0]).toEqual({ key: 'South', label: 'South', href: '/employees?region=South', count: 4 });
  });

  it('leaves the city out of the figures — staff have a region, not a city — but keeps it in the key', async () => {
    const result = await read({ ...QUERY, city: 'Bengaluru' });
    expect(result.city).toBe('Bengaluru');
    expect(result.tiles.joined).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(state.cache.readThrough).toHaveBeenCalledWith(sectionOverviewCacheKey('employees', '2026-09-01', '2026-09-10', 'Bengaluru'), SECTION_OVERVIEW_CACHE_SECONDS, expect.any(Function));
    expect(sectionOverviewCacheKey('employees', '2026-09-01', '2026-09-10', 'Bengaluru')).toBe('section-overviews:employees:2026-09-01:2026-09-10:bengaluru');
  });
});
