import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 29 Sep 2026 — the party rosters, made uniform: `GET /print-partners`
 * takes the door and the KYC state (a shop has no type), passes on the PP-1
 * `applied` facet the schema always took, and answers each row with its
 * jobs counted and the door it came through in the `onboarding` block every
 * party roster carries. A partner keeps no provenance stamp, so the door is
 * read off what the row keeps: applied from the app is self-serve, created
 * by a party import is an import, anything else the desk added.
 */

type AnyFn = (...args: any[]) => any;

const { listPartners } = vi.hoisted(() => ({ listPartners: vi.fn<AnyFn>() }));

vi.mock('../print-partners.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../print-partners.service')>();
  return {
    ...actual,
    listPartners,
    withLastLogin: vi.fn(async (rows: unknown[]) => rows),
    rateCardStateOf: vi.fn(() => ({ hasRateCard: false, fileId: null, fileUrl: null, updatedAt: null, rows: [] })),
  };
});
vi.mock('../kyc/print-partner-kyc.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kyc/print-partner-kyc.service')>();
  return { ...actual, withKycSummary: vi.fn(async (rows: { kycStatus: string }[]) => rows.map((row) => ({ ...row, kyc: { state: 'AWAITING_DOCUMENTS', status: null } }))) };
});
vi.mock('../../../shared/audit', () => ({ auditDiff: vi.fn(), logActivity: vi.fn(), findActivityRows: vi.fn() }));

import { listPartnersHandler } from '../print-partners.controller';
import { listPartnersQuerySchema } from '../print-partners.schema';
import { partnerDoorFacts } from '../print-partners.service';

const T = new Date('2026-09-20T10:00:00.000Z');
const partner = (over: Record<string, unknown> = {}) => ({
  id: 'prt_1',
  displayId: 'PRT-2009-2601',
  userId: 'usr_prt',
  name: 'Balaji Prints',
  mobile: '+919845012345',
  email: null,
  city: 'Pune',
  kycStatus: 'PENDING',
  maxWidthFt: null,
  appliedAt: null,
  activatedAt: null,
  createdAt: T,
  updatedAt: T,
  jobCount: 3,
  importedAt: null,
  ...over,
});

const call = async (query: Record<string, string>) => {
  const res = { json: vi.fn() };
  await listPartnersHandler({ query } as never, res as never);
  return res.json.mock.calls[0]?.[0].data;
};

beforeEach(() => {
  vi.clearAllMocks();
  listPartners.mockResolvedValue({ items: [partner()], total: 1, page: 1, pageSize: 100, counts: { ACTIVE: 1, INACTIVE: 0 } });
});

describe('GET /print-partners — the cuts every party desk takes', () => {
  it('parses the door and the KYC state case-insensitively', () => {
    expect(listPartnersQuerySchema.parse({ onboardedVia: 'import', kycState: 'verified' })).toMatchObject({ onboardedVia: 'IMPORT', kycState: 'VERIFIED' });
    expect(listPartnersQuerySchema.safeParse({ onboardedVia: 'POST' }).success).toBe(false);
    expect(listPartnersQuerySchema.safeParse({ kycState: 'LOST' }).success).toBe(false);
  });

  it('hands the door, the KYC state and the applied facet to the service beside the rest', async () => {
    await call({ q: 'balaji', city: 'pune', active: 'true', applied: 'true', onboardedVia: 'self', kycState: 'pending', pageSize: '100' });
    expect(listPartners).toHaveBeenCalledWith({ page: 1, pageSize: 100, q: 'balaji', city: 'pune', active: true, applied: true, onboardedVia: 'SELF', kycState: 'PENDING' });
  });

  it('answers each row with its jobs counted and the door it came through', async () => {
    listPartners.mockResolvedValue({
      items: [partner(), partner({ id: 'prt_2', appliedAt: T }), partner({ id: 'prt_3', importedAt: T })],
      total: 3,
      page: 1,
      pageSize: 100,
      counts: {},
    });
    const page = await call({});
    expect(page.items.map((row: { jobCount: number }) => row.jobCount)).toEqual([3, 3, 3]);
    expect(page.items.map((row: { onboarding: { via: string } }) => row.onboarding.via)).toEqual(['DESK', 'SELF', 'IMPORT']);
    expect(page.items[0].onboarding).toEqual({ via: 'DESK', viaLabel: 'Desk', byId: null, byName: null, byRole: null, at: T });
    // The import's own moment stays off the wire; the door carries it.
    expect(page.items[0]).not.toHaveProperty('importedAt');
  });
});

describe('GET /print-partners — the Status every party roster takes (2 Oct 2026)', () => {
  it('parses ACTIVE, DEACTIVATED, CLOSED and ALL case-insensitively, and refuses the rest', () => {
    expect(listPartnersQuerySchema.parse({ status: 'closed' })).toMatchObject({ status: 'CLOSED' });
    expect(listPartnersQuerySchema.parse({ status: 'Deactivated' })).toMatchObject({ status: 'DEACTIVATED' });
    expect(listPartnersQuerySchema.parse({ status: 'all' })).toMatchObject({ status: 'ALL' });
    expect(listPartnersQuerySchema.parse({ status: 'ACTIVE' })).toMatchObject({ status: 'ACTIVE' });
    // A print partner has no scoped suspension.
    expect(listPartnersQuerySchema.safeParse({ status: 'SUSPENDED' }).success).toBe(false);
    expect(listPartnersQuerySchema.safeParse({ status: 'EXITED' }).success).toBe(false);
  });

  it('hands the Status to the service beside `active=` — the repository lets the Status win', async () => {
    await call({ status: 'closed', active: 'true' });
    expect(listPartners).toHaveBeenCalledWith({ page: 1, pageSize: 20, active: true, status: 'CLOSED' });
    listPartners.mockClear();
    await call({ active: 'false' });
    expect(listPartners.mock.calls[0]![0]).not.toHaveProperty('status');
  });

  it('answers each row with its account state, and the counts per state beside the page', async () => {
    listPartners.mockResolvedValue({
      items: [partner({ accountState: 'ACTIVE' }), partner({ id: 'prt_2', accountState: 'CLOSED' })],
      total: 2,
      page: 1,
      pageSize: 100,
      counts: { ACTIVE: 1, INACTIVE: 1 },
      statusCounts: { ACTIVE: 1, DEACTIVATED: 0, CLOSED: 1 },
    });
    const page = await call({ status: 'all' });
    expect(page.items.map((row: { accountState: string }) => row.accountState)).toEqual(['ACTIVE', 'CLOSED']);
    expect(page.statusCounts).toEqual({ ACTIVE: 1, DEACTIVATED: 0, CLOSED: 1 });
    // The older ACTIVE / INACTIVE counts stay for the callers that read them.
    expect(page.counts).toEqual({ ACTIVE: 1, INACTIVE: 1 });
  });
});

describe('partnerDoorFacts', () => {
  it('reads applied from the app as self-serve, an import as an import, and the rest as the desk', () => {
    const applied = new Date('2026-09-21T00:00:00.000Z');
    const imported = new Date('2026-09-22T00:00:00.000Z');
    expect(partnerDoorFacts({ appliedAt: applied, createdAt: T })).toMatchObject({ via: 'SELF', viaLabel: 'Self-serve', at: applied });
    expect(partnerDoorFacts({ appliedAt: null, createdAt: T, importedAt: imported })).toMatchObject({ via: 'IMPORT', viaLabel: 'Import', at: imported });
    expect(partnerDoorFacts({ appliedAt: null, createdAt: T })).toMatchObject({ via: 'DESK', viaLabel: 'Desk', at: T });
  });
});
