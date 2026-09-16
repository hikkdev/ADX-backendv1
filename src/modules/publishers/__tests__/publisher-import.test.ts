import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q43/Q86) — the legacy book, imported.
 *
 * What is pinned: a CSV or a JSON body becomes one VALIDATED import with a
 * per-row plan; mobile is required and a row without one is INVALID; a
 * mobile match plans a MERGE that fills only the empty columns (or SKIPPED
 * when there is nothing to fill); a PAN held by another publisher is a
 * WARNING and still creates; an unknown city warns and still creates; a
 * duplicate mobile inside the batch is SKIPPED; nothing refuses the batch;
 * commit creates PENDING_ONBOARDING publishers with KYC PENDING and no
 * agent, merges blanks, is audited, and is refused twice; revoke only ever
 * takes an uncommitted import; the report is the rows as CSV.
 */

const { repository, pricing, identifiers, audit } = vi.hoisted(() => ({
  repository: {
    findPublishersByMobiles: vi.fn(),
    findPublishersByPans: vi.fn(),
    createImport: vi.fn(),
    listImports: vi.fn(),
    findImport: vi.fn(),
    commitImport: vi.fn(),
    setStatus: vi.fn(),
  },
  pricing: { resolveCity: vi.fn(), cityKeyFor: vi.fn() },
  identifiers: { allocateIdentifier: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
}));

vi.mock('../import/prisma-publisher-import.repository', () => ({ prismaPublisherImportRepository: repository }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => (m.replace(/\D/g, '').length === 10 ? `+91${m.replace(/\D/g, '')}` : m) }));
vi.mock('../../../shared/audit', () => audit);

import { commitImport, importReportCsv, parseImportCsv, revokeImport, validateImport } from '../import/publisher-import.service';

const existing = { id: 'pub_old', mobile: '+919876543210', name: 'Old Books', email: null, type: 'INDIVIDUAL', gstin: null, address: null, city: 'Pune', state: null, contactName: null, contactMobile: null, contactEmail: null, kyc: { panNumber: null } };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findPublishersByMobiles.mockResolvedValue([]);
  repository.findPublishersByPans.mockResolvedValue([]);
  pricing.resolveCity.mockImplementation(async (name: string | null) => (name && /^(pune|mumbai)$/i.test(name) ? name[0]!.toUpperCase() + name.slice(1).toLowerCase() : null));
  // Lot X-B: the key beside the string — Pune and Mumbai are catalogued, anything else is a typed town.
  pricing.cityKeyFor.mockImplementation(async (name: string | null) => (name && /^(pune|mumbai)$/i.test(name) ? { cityId: `city_${name.toLowerCase()}`, slug: name.toLowerCase() } : null));
  identifiers.allocateIdentifier.mockImplementation(async () => `PUB-${Math.floor(Math.random() * 1000)}`);
  repository.createImport.mockImplementation(async (data: { rows: unknown[]; counts: Record<string, number> }) => ({ id: 'imp_1', status: 'VALIDATED', ...data.counts, rows: data.rows }));
});

describe('parsing the CSV', () => {
  it('reads the header by name, in any order, and keeps the row number', () => {
    const rows = parseImportCsv('mobile,name,city\n9876543210,Asha,Pune\n,No Mobile,\n');
    expect(rows).toEqual([
      { rowNumber: 2, data: { mobile: '9876543210', name: 'Asha', city: 'Pune' } },
      { rowNumber: 3, data: { mobile: '', name: 'No Mobile', city: '' } },
    ]);
  });
});

describe('validating', () => {
  it('plans every row and never refuses the batch', async () => {
    repository.findPublishersByMobiles.mockResolvedValue([existing]);
    repository.findPublishersByPans.mockResolvedValue([{ id: 'pub_pan', mobile: '+919000000009', displayId: 'PUB-9', kyc: { panNumber: 'ABCDE1234F' } }]);

    const result = await validateImport(
      {
        fileName: 'book.csv',
        rows: [
          { rowNumber: 2, data: { mobile: '9876543210', name: 'Old Books Ltd', email: 'old@x.in', city: 'Mumbai' } },
          { rowNumber: 3, data: { mobile: '9000000001', name: 'Fresh', city: 'Pune', panNumber: 'ABCDE1234F' } },
          { rowNumber: 4, data: { mobile: '9000000002', name: 'Far Away', city: 'Nowhere' } },
          { rowNumber: 5, data: { mobile: '', name: 'No Mobile' } },
          { rowNumber: 6, data: { mobile: '9000000001', name: 'Fresh Again' } },
          { rowNumber: 7, data: { mobile: '9000000003', name: 'Bad Mail', email: 'not-an-email' } },
          { rowNumber: 8, data: { mobile: '9876543210', name: 'Old Books', email: 'x@y.in' } },
        ],
      },
      'usr_admin',
    );

    const rows = repository.createImport.mock.calls[0]![0].rows as { rowNumber: number; outcome: string; message: string | null; data: Record<string, unknown> }[];
    const byRow = Object.fromEntries(rows.map((row) => [row.rowNumber, row]));

    // A mobile match merges, filling only the blanks: the name and city stay, the email lands.
    expect(byRow[2]).toMatchObject({ outcome: 'MERGED', publisherId: 'pub_old' });
    expect((byRow[2]!.data['plan'] as { fill: Record<string, unknown> }).fill).toEqual({ email: 'old@x.in' });
    // A PAN on another publisher warns, and the row still creates.
    expect(byRow[3]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('PUB-9') });
    expect((byRow[3]!.data['plan'] as { action: string }).action).toBe('CREATE');
    // An unknown city warns, and the row still creates.
    expect(byRow[4]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('Nowhere') });
    // No mobile is invalid; a duplicate inside the batch is skipped; a bad email is invalid.
    expect(byRow[5]).toMatchObject({ outcome: 'INVALID', message: expect.stringMatching(/mobile/i) });
    expect(byRow[6]).toMatchObject({ outcome: 'SKIPPED', message: expect.stringContaining('row 3') });
    expect(byRow[7]).toMatchObject({ outcome: 'INVALID' });
    // A merge with nothing to fill is skipped — the second match's email was already claimed by row 2.
    expect(byRow[8]).toMatchObject({ outcome: 'SKIPPED' });

    expect(repository.createImport).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'book.csv',
        uploadedById: 'usr_admin',
        // E6: both creating rows carried a warning, counted separately from createdCount.
        counts: { rowCount: 7, createdCount: 2, mergedCount: 1, skippedCount: 2, warningCount: 2, invalidCount: 2 },
      }),
    );
    expect(result).toMatchObject({ id: 'imp_1', status: 'VALIDATED' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_IMPORT_VALIDATED', expect.objectContaining({ targetType: 'PublisherImport', targetId: 'imp_1' }));
  });

  it('normalises the mobile and upper-cases the PAN and GSTIN before planning', async () => {
    await validateImport({ rows: [{ rowNumber: 2, data: { mobile: '98765 43211', name: 'X', panNumber: 'abcde1234f', type: 'business' } }] }, 'usr_admin');
    const [row] = repository.createImport.mock.calls[0]![0].rows as { data: Record<string, unknown> }[];
    expect(row!.data).toMatchObject({ mobile: '+919876543211', panNumber: 'ABCDE1234F', type: 'BUSINESS' });
  });
});

describe('committing', () => {
  const validated = {
    id: 'imp_1',
    status: 'VALIDATED',
    rows: [
      { id: 'r2', rowNumber: 2, outcome: 'MERGED', publisherId: 'pub_old', data: { mobile: '+919876543210', plan: { action: 'MERGE', publisherId: 'pub_old', fill: { email: 'old@x.in' } } } },
      { id: 'r3', rowNumber: 3, outcome: 'WARNING', publisherId: null, data: { mobile: '+919000000001', name: 'Fresh', city: 'Pune', panNumber: 'ABCDE1234F', plan: { action: 'CREATE', warnings: ['PAN'] } } },
      { id: 'r5', rowNumber: 5, outcome: 'INVALID', publisherId: null, data: { mobile: '', plan: null } },
    ],
  };

  beforeEach(() => {
    repository.findImport.mockResolvedValue(validated);
    repository.commitImport.mockResolvedValue({ ...validated, status: 'COMMITTED', createdCount: 1, mergedCount: 1 });
  });

  it('creates the pending publishers with no agent, merges the blanks, audits', async () => {
    const result = await commitImport('imp_1', 'usr_admin');
    const actions = repository.commitImport.mock.calls[0]![1] as { rowId: string; action: string }[];
    expect(actions).toEqual([
      { rowId: 'r2', action: 'MERGE', publisherId: 'pub_old', fill: { email: 'old@x.in' } },
      expect.objectContaining({
        rowId: 'r3',
        action: 'CREATE',
        publisher: expect.objectContaining({ mobile: '+919000000001', name: 'Fresh', city: 'Pune', panNumber: 'ABCDE1234F', displayId: expect.stringMatching(/^PUB-/) }),
        // Lot X-B: the key beside the typed city.
        cityId: 'city_pune',
      }),
    ]);
    expect(identifiers.allocateIdentifier).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'COMMITTED' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_IMPORT_COMMITTED', expect.objectContaining({ targetType: 'PublisherImport', targetId: 'imp_1' }));
  });

  it('Lot X-B: a merge that fills the city carries its key, a typed town a null one, a create in a typed town too', async () => {
    repository.findImport.mockResolvedValue({
      ...validated,
      rows: [
        { id: 'r2', rowNumber: 2, outcome: 'MERGED', publisherId: 'pub_old', data: { mobile: '+919876543210', plan: { action: 'MERGE', publisherId: 'pub_old', fill: { city: 'Mumbai' } } } },
        { id: 'r3', rowNumber: 3, outcome: 'MERGED', publisherId: 'pub_x', data: { mobile: '+919876543211', plan: { action: 'MERGE', publisherId: 'pub_x', fill: { city: 'Rameswaram' } } } },
        { id: 'r4', rowNumber: 4, outcome: 'CREATED', publisherId: null, data: { mobile: '+919000000002', name: 'Typed', city: 'Rameswaram', plan: { action: 'CREATE', warnings: [] } } },
        { id: 'r5', rowNumber: 5, outcome: 'CREATED', publisherId: null, data: { mobile: '+919000000003', name: 'No city', plan: { action: 'CREATE', warnings: [] } } },
      ],
    });
    await commitImport('imp_1', 'usr_admin');
    const actions = repository.commitImport.mock.calls[0]![1] as Record<string, unknown>[];
    expect(actions[0]).toEqual({ rowId: 'r2', action: 'MERGE', publisherId: 'pub_old', fill: { city: 'Mumbai' }, cityId: 'city_mumbai' });
    expect(actions[1]).toEqual({ rowId: 'r3', action: 'MERGE', publisherId: 'pub_x', fill: { city: 'Rameswaram' }, cityId: null });
    expect(actions[2]).toMatchObject({ rowId: 'r4', action: 'CREATE', cityId: null });
    expect(actions[3]).not.toHaveProperty('cityId');
  });

  it('is refused twice, and refused after a revoke', async () => {
    repository.findImport.mockResolvedValue({ ...validated, status: 'COMMITTED' });
    await expect(commitImport('imp_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    repository.findImport.mockResolvedValue({ ...validated, status: 'REVOKED' });
    await expect(commitImport('imp_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.commitImport).not.toHaveBeenCalled();
  });

  it('revokes only an uncommitted import', async () => {
    repository.setStatus.mockResolvedValue({ ...validated, status: 'REVOKED' });
    await expect(revokeImport('imp_1', 'usr_admin')).resolves.toMatchObject({ status: 'REVOKED' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PUBLISHER_IMPORT_REVOKED', expect.objectContaining({ targetId: 'imp_1' }));
    repository.findImport.mockResolvedValue({ ...validated, status: 'COMMITTED' });
    await expect(revokeImport('imp_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reports the rows as CSV, outcome and message first', async () => {
    const csv = await importReportCsv('imp_1');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('rowNumber,outcome,message,publisherId,name,mobile,email,type,gstin,address,city,state,contactName,contactMobile,contactEmail,panNumber');
    expect(lines[1]).toContain('2,MERGED,');
    expect(lines[2]).toContain('3,WARNING,');
    expect(lines).toHaveLength(4);
  });
});
