import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot S — the publisher importer, generalised.
 *
 * What is pinned, per party: the CSV or JSON body becomes one VALIDATED
 * import with a per-row plan; mobile is required and normalised; email is
 * lower-cased; PAN and GSTIN upper-cased and format-checked; an unknown
 * city warns and still creates; a mobile match plans a MERGE that fills
 * only the empty columns (SKIPPED when nothing is left); a PAN or GSTIN on
 * another row of the party is a WARNING and still creates; a duplicate
 * mobile inside the batch is SKIPPED; a malformed value is INVALID and
 * names the field; nothing refuses the batch. Commit creates through the
 * party's own creation service (never a row of its own), merges through its
 * update service, stamps targetId, merges into a number that joined between
 * validation and commit, is audited, is refused twice and after a revoke,
 * and resumes from its per-row marker. The report is the rows as CSV.
 */

const { repository, pricing, audit, advertisers, agents, printPartners, employees, users } = vi.hoisted(() => ({
  repository: {
    createImport: vi.fn(),
    listImports: vi.fn(),
    findImport: vi.fn(),
    stampRow: vi.fn(),
    finishCommit: vi.fn(),
    setStatus: vi.fn(),
    matchAdvertisers: vi.fn(),
    matchAgents: vi.fn(),
    matchPrintPartners: vi.fn(),
    matchEmployees: vi.fn(),
    findUserByMobile: vi.fn(),
  },
  pricing: { resolveCity: vi.fn(), citySupport: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  advertisers: {
    registerAdvertiser: vi.fn(),
    updateProfile: vi.fn(),
    advertiserTypeSchema: { parse: (v: unknown) => v },
    ADVERTISER_INDUSTRIES: ['Retail', 'Food & beverage', 'Other'],
  },
  agents: { createAgent: vi.fn(), updateAgent: vi.fn() },
  printPartners: { createPartner: vi.fn(), updatePartner: vi.fn() },
  employees: { createEmployee: vi.fn(), updateEmployee: vi.fn(), WORK_MODES: ['OFFICE', 'REMOTE', 'HYBRID', 'FIELD'], EMPLOYMENT_TYPES: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] },
  users: { createUser: vi.fn() },
}));

vi.mock('../prisma-party-imports.repository', () => ({ prismaPartyImportsRepository: repository }));
vi.mock('../../pricing', () => pricing);
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => (m.replace(/\D/g, '').length === 10 ? `+91${m.replace(/\D/g, '')}` : m) }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../advertisers', async () => {
  const { z } = await import('zod');
  return { ...advertisers, advertiserTypeSchema: z.enum(['INDIVIDUAL', 'COMMERCIAL', 'NGO', 'AGENCY']) };
});
vi.mock('../../agents', () => agents);
vi.mock('../../print-partners', () => printPartners);
vi.mock('../../employees', () => employees);
vi.mock('../../users', () => users);

import { commitImport, importReportCsv, parseImportCsv, revokeImport, validateImport } from '../party-imports.service';

type Row = { rowNumber: number; outcome: string; message: string | null; targetId: string | null; data: Record<string, unknown> };

const emptyMatch = () => ({ byMobile: [], byPan: new Map(), byGstin: new Map(), blockedMobiles: new Map(), takenEmails: new Map() });
const validatedRows = () => repository.createImport.mock.calls[0]![0].rows as Row[];
const byRowNumber = (rows: Row[]) => Object.fromEntries(rows.map((row) => [row.rowNumber, row]));

beforeEach(() => {
  vi.clearAllMocks();
  for (const match of [repository.matchAdvertisers, repository.matchAgents, repository.matchPrintPartners, repository.matchEmployees]) match.mockImplementation(async () => emptyMatch());
  pricing.resolveCity.mockImplementation(async (name: string | null) => (name && /^(pune|mumbai)$/i.test(name) ? name[0]!.toUpperCase() + name.slice(1).toLowerCase() : null));
  // Lot V: Pune is launched, Mumbai is planned (nothing on), anything else is outside the catalogue.
  const OPEN = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
  const OFF = { supplyIntake: false, publishing: false, demand: false, agentOnboarding: false, printPartners: false, leadFeeds: false };
  pricing.citySupport.mockImplementation(async (name: string) =>
    /^pune$/i.test(name)
      ? { support: 'ACTIVE', resolved: true, stage: 'LAUNCHED', switches: OPEN, city: { slug: 'pune', name: 'Pune' } }
      : /^mumbai$/i.test(name)
        ? { support: 'INACTIVE', resolved: true, stage: 'PLANNED', switches: OFF, city: { slug: 'mumbai', name: 'Mumbai' } }
        : { support: 'UNKNOWN', resolved: false, stage: null, switches: OPEN, city: null },
  );
  repository.createImport.mockImplementation(async (data: { party: string; rows: unknown[]; counts: Record<string, number> }) => ({ id: 'imp_1', party: data.party, status: 'VALIDATED', ...data.counts, rows: data.rows }));
  repository.stampRow.mockResolvedValue(undefined);
  repository.findUserByMobile.mockResolvedValue(null);
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

describe('advertisers: validating', () => {
  const existing = {
    id: 'adv_old',
    displayId: 'ADV-1',
    mobile: '+919876543210',
    label: 'Old Ads',
    fields: { name: 'Old Ads', email: null, type: 'INDIVIDUAL', companyName: null, industry: null, gstin: null, address: null, city: 'Pune', state: null, panNumber: null },
  };

  it('plans every row and never refuses the batch', async () => {
    repository.matchAdvertisers.mockResolvedValue({
      ...emptyMatch(),
      byMobile: [existing],
      byPan: new Map([['ABCDE1234F', { id: 'adv_pan', displayId: 'ADV-9', mobile: '+919000000009', label: 'Pan Holder', fields: {} }]]),
      byGstin: new Map([['27ABCDE1234F1Z5', { id: 'adv_gst', displayId: 'ADV-8', mobile: '+919000000008', label: 'Gst Holder', fields: {} }]]),
    });

    const result = await validateImport(
      'advertisers',
      {
        fileName: 'book.csv',
        rows: [
          { rowNumber: 2, data: { mobile: '9876543210', name: 'Old Ads Ltd', email: 'OLD@X.IN', city: 'Mumbai', state: 'MH' } },
          { rowNumber: 3, data: { mobile: '9000000001', name: 'Fresh', city: 'Pune', panNumber: 'abcde1234f' } },
          { rowNumber: 4, data: { mobile: '9000000002', name: 'Far Away', city: 'Nowhere' } },
          { rowNumber: 5, data: { mobile: '', name: 'No Mobile' } },
          { rowNumber: 6, data: { mobile: '9000000001', name: 'Fresh Again' } },
          { rowNumber: 7, data: { mobile: '9000000003', name: 'Bad Mail', email: 'not-an-email' } },
          { rowNumber: 8, data: { mobile: '9876543210', name: 'Old Ads', email: 'x@y.in' } },
          { rowNumber: 9, data: { mobile: '9000000004', name: 'Gst Twin', gstin: '27abcde1234f1z5' } },
          { rowNumber: 10, data: { mobile: '9000000005', name: 'Bad Type', type: 'SHOP' } },
          { rowNumber: 11, data: { mobile: '9000000006', name: 'Plain', type: 'commercial', industry: 'retail' } },
        ],
      },
      'usr_admin',
    );

    const byRow = byRowNumber(validatedRows());
    // A mobile match merges, filling only the blanks: the name and city stay, the email and state land.
    expect(byRow[2]).toMatchObject({ outcome: 'MERGED', targetId: 'adv_old' });
    expect((byRow[2]!.data['plan'] as { fill: Record<string, unknown> }).fill).toEqual({ email: 'old@x.in', state: 'MH' });
    // A PAN on another advertiser warns, and the row still creates — upper-cased.
    expect(byRow[3]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('ADV-9') });
    expect(byRow[3]!.data).toMatchObject({ panNumber: 'ABCDE1234F' });
    expect((byRow[3]!.data['plan'] as { action: string }).action).toBe('CREATE');
    // An unknown city warns, and the row still creates.
    expect(byRow[4]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('Nowhere') });
    // No mobile is invalid; a duplicate inside the batch is skipped; a bad email is invalid.
    expect(byRow[5]).toMatchObject({ outcome: 'INVALID', message: 'mobile is required' });
    expect(byRow[6]).toMatchObject({ outcome: 'SKIPPED', message: expect.stringContaining('row 3') });
    expect(byRow[7]).toMatchObject({ outcome: 'INVALID', message: expect.stringMatching(/^email:/) });
    // A merge with nothing to fill is skipped — the second match's email was already claimed by row 2.
    expect(byRow[8]).toMatchObject({ outcome: 'SKIPPED' });
    // A GSTIN on another advertiser warns, and the row still creates.
    expect(byRow[9]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('ADV-8') });
    expect(byRow[9]!.data).toMatchObject({ gstin: '27ABCDE1234F1Z5' });
    // A type off the enum is invalid and names the field.
    expect(byRow[10]).toMatchObject({ outcome: 'INVALID', message: expect.stringMatching(/^type:/) });
    // The enum and the industry picklist accept any casing.
    expect(byRow[11]).toMatchObject({ outcome: 'CREATED' });
    expect(byRow[11]!.data).toMatchObject({ type: 'COMMERCIAL', industry: 'Retail' });

    expect(repository.createImport).toHaveBeenCalledWith(
      expect.objectContaining({
        party: 'ADVERTISER',
        fileName: 'book.csv',
        uploadedById: 'usr_admin',
        counts: { rowCount: 10, createdCount: 4, mergedCount: 1, skippedCount: 2, warningCount: 3, invalidCount: 3 },
      }),
    );
    expect(result).toMatchObject({ id: 'imp_1', status: 'VALIDATED' });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'PARTY_IMPORT_VALIDATED',
      expect.objectContaining({ targetType: 'PartyImport', targetId: 'imp_1', metadata: expect.objectContaining({ party: 'ADVERTISER', counts: expect.objectContaining({ rowCount: 10 }) }) }),
    );
  });

  it('normalises the mobile, lower-cases the email and says which columns are kept on the report only', async () => {
    await validateImport('advertisers', { rows: [{ rowNumber: 2, data: { mobile: '98765 43211', name: 'X', email: 'Person@Example.COM', panNumber: 'abcde1234f', contactName: 'Asha' } }] }, 'usr_admin');
    const [row] = validatedRows();
    expect(row!.data).toMatchObject({ mobile: '+919876543211', email: 'person@example.com', panNumber: 'ABCDE1234F' });
    expect(row!.message).toContain('panNumber, contactName kept on the report only');
  });
});

describe('agents: validating', () => {
  it('requires the side, checks the email against accounts and the batch, and merges only the profile columns', async () => {
    repository.matchAgents.mockResolvedValue({
      ...emptyMatch(),
      byMobile: [{ id: 'agt_1', displayId: 'AGT-1', mobile: '+919876543210', label: 'Ravi', fields: { name: 'Ravi', email: null, city: null, state: 'MH' } }],
      takenEmails: new Map([['taken@x.in', '+919111111111'], ['own@x.in', '+919000000006']]),
    });
    await validateImport(
      'agents',
      {
        rows: [
          { rowNumber: 2, data: { mobile: '9000000001', name: 'New', side: 'publisher', city: 'pune' } },
          { rowNumber: 3, data: { mobile: '9000000002', name: 'No Side' } },
          { rowNumber: 4, data: { mobile: '9000000003', name: 'Taken', side: 'ADVERTISER', email: 'Taken@x.in' } },
          { rowNumber: 5, data: { mobile: '9000000004', name: 'Twin A', side: 'ADVERTISER', email: 'twin@x.in' } },
          { rowNumber: 6, data: { mobile: '9000000005', name: 'Twin B', side: 'ADVERTISER', email: 'twin@x.in' } },
          { rowNumber: 7, data: { mobile: '9876543210', name: 'Ravi Renamed', email: 'ravi@x.in', side: 'PUBLISHER', city: 'Mumbai', state: 'GJ' } },
          { rowNumber: 8, data: { mobile: '9000000006', name: 'Own Email', side: 'PUBLISHER', email: 'own@x.in' } },
          // Lot V: a new agent in a city whose stage is not onboarding agents — INVALID, named; a town off the catalogue is free text.
          { rowNumber: 9, data: { mobile: '9000000007', name: 'Planned City', side: 'PUBLISHER', city: 'Mumbai' } },
          { rowNumber: 10, data: { mobile: '9000000008', name: 'Off Catalogue', side: 'PUBLISHER', city: 'Rameswaram' } },
        ],
      },
      'usr_admin',
    );
    const byRow = byRowNumber(validatedRows());
    expect(byRow[9]).toMatchObject({ outcome: 'INVALID', message: 'city: ADX is not onboarding agents in Mumbai (planned)' });
    expect(byRow[10]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('not in the catalogue') });
    expect(byRow[2]).toMatchObject({ outcome: 'CREATED' });
    expect(byRow[2]!.data).toMatchObject({ side: 'PUBLISHER', city: 'Pune' });
    expect(byRow[3]).toMatchObject({ outcome: 'INVALID', message: 'side is required' });
    expect(byRow[4]).toMatchObject({ outcome: 'INVALID', message: 'email: already on another account' });
    expect(byRow[5]).toMatchObject({ outcome: 'CREATED' });
    expect(byRow[6]).toMatchObject({ outcome: 'INVALID', message: 'email: already used by row 5 in this file' });
    // The match merges the profile's own empty column only: the name and email are the User's, the state is held.
    expect(byRow[7]).toMatchObject({ outcome: 'MERGED', targetId: 'agt_1' });
    expect((byRow[7]!.data['plan'] as { fill: Record<string, unknown> }).fill).toEqual({ city: 'Mumbai' });
    // An email on the account that holds this very number is not "another account": a publisher becoming an agent keeps theirs.
    expect(byRow[8]).toMatchObject({ outcome: 'CREATED' });
    // Row 7 merges into an existing agent under a planned city: a merge is not an onboarding, so it is not gated.
    expect(repository.createImport).toHaveBeenCalledWith(expect.objectContaining({ party: 'AGENT', counts: expect.objectContaining({ rowCount: 9, createdCount: 4, mergedCount: 1, invalidCount: 4 }) }));
  });
});

describe('print partners: validating', () => {
  it('parses the shop columns, refuses a number on another account per row, warns on a shared PAN, merges the blanks', async () => {
    repository.matchPrintPartners.mockResolvedValue({
      ...emptyMatch(),
      byMobile: [{ id: 'prt_1', displayId: 'PRT-1', mobile: '+919876543210', label: 'Old Press', fields: { name: 'Old Press', legalName: null, gstin: null, panNumber: 'ABCDE1234F', contactName: null, email: null, address: null, city: null, capabilities: 'flex', maxWidthFt: null, turnaroundDays: null } }],
      byPan: new Map([['ABCDE1234F', { id: 'prt_1', displayId: 'PRT-1', mobile: '+919876543210', label: 'Old Press', fields: {} }]]),
      blockedMobiles: new Map([['+919000000009', 'mobile already belongs to an ADX account; a print partner needs its own number']]),
    });
    await validateImport(
      'print-partners',
      {
        rows: [
          { rowNumber: 2, data: { mobile: '9000000001', name: 'New Press', capabilities: ' flex | vinyl |', maxWidthFt: '12.5', turnaroundDays: '3', gstin: '27abcde1234f1z5' } },
          { rowNumber: 3, data: { mobile: '9000000002', name: 'Bad Width', maxWidthFt: 'wide' } },
          { rowNumber: 4, data: { mobile: '9000000003', name: 'Bad Days', turnaroundDays: '400' } },
          { rowNumber: 5, data: { mobile: '9000000009', name: 'A Publisher' } },
          { rowNumber: 6, data: { mobile: '9000000004', name: 'Same PAN', panNumber: 'ABCDE1234F' } },
          { rowNumber: 7, data: { mobile: '9876543210', name: 'Old Press Renamed', legalName: 'Old Press Pvt Ltd', capabilities: 'vinyl', panNumber: 'ABCDE1234F' } },
        ],
      },
      'usr_admin',
    );
    const byRow = byRowNumber(validatedRows());
    expect(byRow[2]).toMatchObject({ outcome: 'CREATED' });
    expect(byRow[2]!.data).toMatchObject({ capabilities: 'flex|vinyl', maxWidthFt: '12.5', turnaroundDays: '3', gstin: '27ABCDE1234F1Z5' });
    expect(byRow[3]).toMatchObject({ outcome: 'INVALID', message: expect.stringMatching(/^maxWidthFt:/) });
    expect(byRow[4]).toMatchObject({ outcome: 'INVALID', message: expect.stringMatching(/^turnaroundDays:/) });
    expect(byRow[5]).toMatchObject({ outcome: 'INVALID', message: expect.stringContaining('needs its own number') });
    expect(byRow[6]).toMatchObject({ outcome: 'WARNING', message: expect.stringContaining('PRT-1') });
    // The match's own PAN is not a warning against itself; only the legal name is empty.
    expect(byRow[7]).toMatchObject({ outcome: 'MERGED', targetId: 'prt_1', message: expect.not.stringContaining('PAN') });
    expect((byRow[7]!.data['plan'] as { fill: Record<string, unknown> }).fill).toEqual({ legalName: 'Old Press Pvt Ltd' });
  });
});

describe('employees: validating', () => {
  it('parses the HR columns as enums, merges the record\'s own blanks, and keeps a bad enum out', async () => {
    repository.matchEmployees.mockResolvedValue({
      ...emptyMatch(),
      byMobile: [{ id: 'emp_1', userId: 'usr_emp', displayId: 'EMP-1', mobile: '+919876543210', label: 'Meera', fields: { name: 'Meera', email: 'meera@x.in', department: 'Ops', designation: null, region: null, workMode: null, employmentType: 'FULL_TIME' } }],
    });
    await validateImport(
      'employees',
      {
        rows: [
          { rowNumber: 2, data: { mobile: '9000000001', name: 'New Hire', email: 'NEW@X.IN', department: 'Sales', workMode: 'remote', employmentType: 'contract' } },
          { rowNumber: 3, data: { mobile: '9000000002', name: 'Bad Mode', workMode: 'BOAT' } },
          { rowNumber: 4, data: { mobile: '9876543210', name: 'Meera M', department: 'Finance', designation: 'Analyst', region: 'West', workMode: 'HYBRID' } },
        ],
      },
      'usr_admin',
    );
    const byRow = byRowNumber(validatedRows());
    expect(byRow[2]).toMatchObject({ outcome: 'CREATED' });
    expect(byRow[2]!.data).toMatchObject({ email: 'new@x.in', workMode: 'REMOTE', employmentType: 'CONTRACT' });
    expect(byRow[3]).toMatchObject({ outcome: 'INVALID', message: expect.stringMatching(/^workMode:/) });
    expect(byRow[4]).toMatchObject({ outcome: 'MERGED', targetId: 'emp_1' });
    expect((byRow[4]!.data['plan'] as { fill: Record<string, unknown> }).fill).toEqual({ designation: 'Analyst', region: 'West', workMode: 'HYBRID' });
  });

  it('T-B: the answer carries targetUserId beside targetId — the account the employees page is addressed by', async () => {
    repository.matchEmployees.mockResolvedValue({
      ...emptyMatch(),
      byMobile: [{ id: 'emp_1', userId: 'usr_emp', displayId: 'EMP-1', mobile: '+919876543210', label: 'Meera', fields: { name: 'Meera', region: null } }],
    });
    const answer = await validateImport(
      'employees',
      {
        rows: [
          { rowNumber: 2, data: { mobile: '9876543210', name: 'Meera', region: 'West' } },
          { rowNumber: 3, data: { mobile: '9000000001', name: 'New Hire' } },
        ],
      },
      'usr_admin',
    );
    const byRow = byRowNumber(answer.rows as unknown as Row[]);
    expect(byRow[2]).toMatchObject({ outcome: 'MERGED', targetId: 'emp_1', targetUserId: 'usr_emp' });
    expect(byRow[3]).toMatchObject({ outcome: 'CREATED', targetId: null, targetUserId: null });
  });
});

describe('committing', () => {
  const validated = (party: string, rows: Row[]) => ({ id: 'imp_1', party, status: 'VALIDATED', fileName: 'book.csv', rows });

  beforeEach(() => {
    repository.finishCommit.mockImplementation(async (id: string, counts: Record<string, number>) => ({ id, status: 'COMMITTED', fileName: 'book.csv', ...counts, rows: [] }));
  });

  it('advertisers: creates through registerAdvertiser with no user and no agent, merges through updateProfile, stamps the rows, audits', async () => {
    const rows: Row[] = [
      { rowNumber: 2, outcome: 'MERGED', targetId: 'adv_old', message: null, data: { mobile: '+919876543210', name: 'Old Ads Ltd', email: 'old@x.in', plan: { action: 'MERGE', targetId: 'adv_old', fill: { email: 'old@x.in' }, warnings: [] } } },
      { rowNumber: 3, outcome: 'WARNING', targetId: null, message: null, data: { mobile: '+919000000001', name: 'Fresh', city: 'Pune', type: 'COMMERCIAL', companyName: 'Fresh Co', address: '1 Lane', panNumber: 'ABCDE1234F', plan: { action: 'CREATE', warnings: ['PAN'] } } },
      { rowNumber: 5, outcome: 'INVALID', targetId: null, message: 'mobile is required', data: { mobile: '', plan: null } },
    ].map((row, index) => ({ ...row, id: `r${index}` })) as unknown as Row[];
    repository.findImport.mockResolvedValue(validated('ADVERTISER', rows));
    repository.matchAdvertisers.mockResolvedValue({
      ...emptyMatch(),
      byMobile: [{ id: 'adv_old', displayId: 'ADV-1', mobile: '+919876543210', label: 'Old Ads', fields: { name: 'Old Ads', email: null } }],
    });
    advertisers.registerAdvertiser.mockResolvedValue({ id: 'adv_new', displayId: 'ADV-2', name: 'Fresh', mobile: '+919000000001' });
    advertisers.updateProfile.mockResolvedValue({ id: 'adv_old' });

    const result = await commitImport('advertisers', 'imp_1', 'usr_admin');

    expect(advertisers.registerAdvertiser).toHaveBeenCalledTimes(1);
    expect(advertisers.registerAdvertiser).toHaveBeenCalledWith(
      expect.objectContaining({ mobile: '+919000000001', name: 'Fresh', city: 'Pune', type: 'COMMERCIAL', companyName: 'Fresh Co', billingAddress: '1 Lane', userId: null, agentId: null }),
    );
    // The PAN is not the profile's to write; nothing else reaches the service.
    expect(advertisers.registerAdvertiser.mock.calls[0]![0]).not.toHaveProperty('panNumber');
    expect(advertisers.updateProfile).toHaveBeenCalledWith('adv_old', { email: 'old@x.in' });
    // Each row is stamped as it lands: the marker, the target, the outcome.
    const stamps = repository.stampRow.mock.calls as [string, { targetId: string | null; outcome?: string; data: { result: { action: string } } }][];
    expect(stamps.find(([rowId]) => rowId === 'r0')![1]).toMatchObject({ targetId: 'adv_old', outcome: 'MERGED', data: { result: { action: 'MERGED', targetId: 'adv_old' } } });
    expect(stamps.find(([rowId]) => rowId === 'r1')![1]).toMatchObject({ targetId: 'adv_new', data: { result: { action: 'CREATED', targetId: 'adv_new' } } });
    expect(stamps.find(([rowId]) => rowId === 'r1')![1]).not.toHaveProperty('outcome');
    expect(stamps.some(([rowId]) => rowId === 'r2')).toBe(false);
    expect(result).toMatchObject({ status: 'COMMITTED' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_CREATED', expect.objectContaining({ targetType: 'Advertiser', targetId: 'adv_new', metadata: expect.objectContaining({ importId: 'imp_1', rowNumber: 3 }) }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'ADVERTISER_PROFILE_UPDATED', expect.objectContaining({ targetType: 'Advertiser', targetId: 'adv_old' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PARTY_IMPORT_COMMITTED', expect.objectContaining({ targetType: 'PartyImport', targetId: 'imp_1', metadata: expect.objectContaining({ party: 'ADVERTISER' }) }));
  });

  it('agents: creates through createAgent with the side, merges city/state through updateAgent', async () => {
    const rows = [
      { id: 'r0', rowNumber: 2, outcome: 'CREATED', targetId: null, message: null, data: { mobile: '+919000000001', name: 'New', email: 'new@x.in', side: 'PUBLISHER', city: 'Pune', plan: { action: 'CREATE', warnings: [] } } },
      { id: 'r1', rowNumber: 3, outcome: 'MERGED', targetId: 'agt_1', message: null, data: { mobile: '+919876543210', city: 'Mumbai', plan: { action: 'MERGE', targetId: 'agt_1', fill: { city: 'Mumbai' }, warnings: [] } } },
    ] as unknown as Row[];
    repository.findImport.mockResolvedValue(validated('AGENT', rows));
    repository.matchAgents.mockResolvedValue({ ...emptyMatch(), byMobile: [{ id: 'agt_1', displayId: 'AGT-1', mobile: '+919876543210', label: 'Ravi', fields: { city: null, state: 'MH' } }] });
    agents.createAgent.mockResolvedValue({ id: 'agt_new', displayId: 'AGT-2' });
    agents.updateAgent.mockResolvedValue({ id: 'agt_1' });

    await commitImport('agents', 'imp_1', 'usr_admin');

    expect(agents.createAgent).toHaveBeenCalledWith({ mobile: '+919000000001', name: 'New', email: 'new@x.in', side: 'PUBLISHER', city: 'Pune' });
    expect(agents.updateAgent).toHaveBeenCalledWith('agt_1', { city: 'Mumbai' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'AGENT_CREATED', expect.objectContaining({ targetType: 'AgentProfile', targetId: 'agt_new' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'AGENT_UPDATED', expect.objectContaining({ targetId: 'agt_1' }));
  });

  it('print partners: creates through createPartner with the capabilities split, merges through updatePartner', async () => {
    const rows = [
      { id: 'r0', rowNumber: 2, outcome: 'CREATED', targetId: null, message: null, data: { mobile: '+919000000001', name: 'New Press', capabilities: 'flex|vinyl', maxWidthFt: '12.5', turnaroundDays: '3', plan: { action: 'CREATE', warnings: [] } } },
      { id: 'r1', rowNumber: 3, outcome: 'MERGED', targetId: 'prt_1', message: null, data: { mobile: '+919876543210', legalName: 'Old Press Pvt Ltd', turnaroundDays: '2', plan: { action: 'MERGE', targetId: 'prt_1', fill: { legalName: 'Old Press Pvt Ltd', turnaroundDays: '2' }, warnings: [] } } },
    ] as unknown as Row[];
    repository.findImport.mockResolvedValue(validated('PRINT_PARTNER', rows));
    repository.matchPrintPartners.mockResolvedValue({ ...emptyMatch(), byMobile: [{ id: 'prt_1', displayId: 'PRT-1', mobile: '+919876543210', label: 'Old Press', fields: { legalName: null, turnaroundDays: null } }] });
    printPartners.createPartner.mockResolvedValue({ id: 'prt_new', displayId: 'PRT-2', name: 'New Press', city: null, userId: 'usr_prt' });
    printPartners.updatePartner.mockResolvedValue({ before: { id: 'prt_1' }, after: { id: 'prt_1' } });

    await commitImport('print-partners', 'imp_1', 'usr_admin');

    expect(printPartners.createPartner).toHaveBeenCalledWith(
      expect.objectContaining({ mobile: '+919000000001', name: 'New Press', capabilities: ['flex', 'vinyl'], maxWidthFt: '12.5', turnaroundDays: 3 }),
    );
    expect(printPartners.updatePartner).toHaveBeenCalledWith('prt_1', { legalName: 'Old Press Pvt Ltd', turnaroundDays: 2 });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PRINT_PARTNER_CREATED', expect.objectContaining({ targetType: 'PrintPartner', targetId: 'prt_new' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PRINT_PARTNER_UPDATED', expect.objectContaining({ targetId: 'prt_1' }));
  });

  it('employees: makes the User through users.createUser, then the record through createEmployee; an account without a record gets the record only; merges through updateEmployee by user id', async () => {
    const rows = [
      { id: 'r0', rowNumber: 2, outcome: 'CREATED', targetId: null, message: null, data: { mobile: '+919000000001', name: 'New Hire', email: 'new@x.in', department: 'Sales', workMode: 'REMOTE', plan: { action: 'CREATE', warnings: [] } } },
      { id: 'r1', rowNumber: 3, outcome: 'CREATED', targetId: null, message: null, data: { mobile: '+919000000002', name: 'Has Account', designation: 'Lead', plan: { action: 'CREATE', warnings: [] } } },
      { id: 'r2', rowNumber: 4, outcome: 'MERGED', targetId: 'emp_1', message: null, data: { mobile: '+919876543210', region: 'West', plan: { action: 'MERGE', targetId: 'emp_1', fill: { region: 'West' }, warnings: [] } } },
    ] as unknown as Row[];
    repository.findImport.mockResolvedValue(validated('EMPLOYEE', rows));
    repository.matchEmployees.mockResolvedValue({ ...emptyMatch(), byMobile: [{ id: 'emp_1', userId: 'usr_emp', displayId: 'EMP-1', mobile: '+919876543210', label: 'Meera', fields: { region: null } }] });
    repository.findUserByMobile.mockImplementation(async (mobile: string) => (mobile === '+919000000002' ? { id: 'usr_existing', employeeId: null } : null));
    users.createUser.mockResolvedValue({ id: 'usr_new', mobile: '+919000000001', name: 'New Hire', email: 'new@x.in' });
    employees.createEmployee.mockImplementation(async (input: { userId: string }) => ({ employee: { id: `emp_${input.userId}`, userId: input.userId, displayId: 'EMP-2' }, inviteToConsole: undefined }));
    employees.updateEmployee.mockResolvedValue({ before: { id: 'emp_1', userId: 'usr_emp' }, after: { id: 'emp_1', userId: 'usr_emp' } });

    await commitImport('employees', 'imp_1', 'usr_admin');

    expect(users.createUser).toHaveBeenCalledTimes(1);
    expect(users.createUser).toHaveBeenCalledWith({ mobile: '+919000000001', name: 'New Hire', email: 'new@x.in', roles: [] });
    expect(employees.createEmployee).toHaveBeenCalledWith({ userId: 'usr_new', department: 'Sales', workMode: 'REMOTE' });
    expect(employees.createEmployee).toHaveBeenCalledWith({ userId: 'usr_existing', designation: 'Lead' });
    expect(employees.updateEmployee).toHaveBeenCalledWith('usr_emp', { region: 'West' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_new', 'USER_CREATED_BY_ADMIN', expect.objectContaining({ targetType: 'User', targetId: 'usr_new' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'EMPLOYEE_CREATED', expect.objectContaining({ targetType: 'Employee', targetId: 'emp_usr_new' }));
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'EMPLOYEE_UPDATED', expect.objectContaining({ targetId: 'emp_1' }));
    // T-B: each stamp names the account beside the record, so the row reads back with targetUserId
    expect(repository.stampRow).toHaveBeenCalledWith('r0', expect.objectContaining({ targetId: 'emp_usr_new', data: expect.objectContaining({ result: expect.objectContaining({ action: 'CREATED', targetUserId: 'usr_new' }) }) }));
    expect(repository.stampRow).toHaveBeenCalledWith('r1', expect.objectContaining({ targetId: 'emp_usr_existing', data: expect.objectContaining({ result: expect.objectContaining({ targetUserId: 'usr_existing' }) }) }));
    expect(repository.stampRow).toHaveBeenCalledWith('r2', expect.objectContaining({ targetId: 'emp_1', data: expect.objectContaining({ result: expect.objectContaining({ action: 'MERGED', targetUserId: 'usr_emp' }) }) }));
  });

  it('T-B: a committed employee row reads back with targetUserId beside targetId', async () => {
    repository.finishCommit.mockResolvedValue({
      id: 'imp_1',
      status: 'COMMITTED',
      fileName: 'book.csv',
      rows: [{ id: 'r0', rowNumber: 2, outcome: 'CREATED', targetId: 'emp_9', message: null, data: { mobile: '+919000000001', plan: { action: 'CREATE', warnings: [] }, result: { action: 'CREATED', targetId: 'emp_9', targetUserId: 'usr_9', at: 'now' } } }],
    });
    repository.findImport.mockResolvedValue(validated('EMPLOYEE', []));
    const committed = await commitImport('employees', 'imp_1', 'usr_admin');
    expect(committed.rows[0]).toMatchObject({ targetId: 'emp_9', targetUserId: 'usr_9' });
  });

  it('merges into a number that joined between validation and commit instead of duplicating it', async () => {
    const rows = [
      { id: 'r0', rowNumber: 2, outcome: 'CREATED', targetId: null, message: null, data: { mobile: '+919000000001', name: 'Fresh', email: 'fresh@x.in', city: 'Pune', plan: { action: 'CREATE', warnings: [] } } },
    ] as unknown as Row[];
    repository.findImport.mockResolvedValue(validated('ADVERTISER', rows));
    repository.matchAdvertisers.mockResolvedValue({ ...emptyMatch(), byMobile: [{ id: 'adv_raced', displayId: 'ADV-7', mobile: '+919000000001', label: 'Fresh', fields: { name: 'Fresh', email: null, city: 'Pune' } }] });
    advertisers.updateProfile.mockResolvedValue({ id: 'adv_raced' });

    await commitImport('advertisers', 'imp_1', 'usr_admin');

    expect(advertisers.registerAdvertiser).not.toHaveBeenCalled();
    expect(advertisers.updateProfile).toHaveBeenCalledWith('adv_raced', { email: 'fresh@x.in' });
    expect(repository.stampRow).toHaveBeenCalledWith('r0', expect.objectContaining({ targetId: 'adv_raced', outcome: 'MERGED', message: expect.stringContaining('joined after validation') }));
  });

  it('marks a row the party\'s service refuses as INVALID with the reason and carries on; an infrastructure error stops the commit, resumable', async () => {
    const { ApiError } = await import('../../../shared/errors');
    const rows = [
      { id: 'r0', rowNumber: 2, outcome: 'CREATED', targetId: null, message: null, data: { mobile: '+919000000001', name: 'A', side: 'PUBLISHER', plan: { action: 'CREATE', warnings: [] } } },
      { id: 'r1', rowNumber: 3, outcome: 'CREATED', targetId: null, message: null, data: { mobile: '+919000000002', name: 'B', side: 'PUBLISHER', plan: { action: 'CREATE', warnings: [] } } },
      { id: 'r2', rowNumber: 4, outcome: 'CREATED', targetId: null, message: null, data: { mobile: '+919000000003', name: 'C', side: 'PUBLISHER', plan: { action: 'CREATE', warnings: [] } } },
    ] as unknown as Row[];
    repository.findImport.mockResolvedValue(validated('AGENT', rows));
    agents.createAgent
      .mockRejectedValueOnce(new ApiError(409, 'CONFLICT', 'That email belongs to another account'))
      .mockResolvedValueOnce({ id: 'agt_b', displayId: 'AGT-B' })
      .mockRejectedValueOnce(new Error('connection reset'));

    await expect(commitImport('agents', 'imp_1', 'usr_admin')).rejects.toThrow('connection reset');

    expect(repository.stampRow).toHaveBeenCalledWith('r0', expect.objectContaining({ outcome: 'INVALID', message: 'Not created: That email belongs to another account', data: expect.objectContaining({ result: expect.objectContaining({ action: 'FAILED' }) }) }));
    expect(repository.stampRow).toHaveBeenCalledWith('r1', expect.objectContaining({ targetId: 'agt_b', outcome: 'CREATED' }));
    expect(repository.finishCommit).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalledWith('usr_admin', 'PARTY_IMPORT_COMMITTED', expect.anything());

    // The second call resumes: the landed row is skipped, the failed row is retried, the rest runs.
    vi.clearAllMocks();
    repository.finishCommit.mockImplementation(async (id: string, counts: Record<string, number>) => ({ id, status: 'COMMITTED', fileName: 'book.csv', ...counts, rows: [] }));
    repository.matchAgents.mockResolvedValue(emptyMatch());
    const stamped = [
      { ...rows[0]!, outcome: 'INVALID', data: { ...rows[0]!.data, result: { action: 'FAILED', targetId: null, at: 'x' } } },
      { ...rows[1]!, targetId: 'agt_b', data: { ...rows[1]!.data, result: { action: 'CREATED', targetId: 'agt_b', at: 'x' } } },
      rows[2]!,
    ];
    repository.findImport.mockResolvedValue(validated('AGENT', stamped));
    agents.createAgent.mockResolvedValueOnce({ id: 'agt_a', displayId: 'AGT-A' }).mockResolvedValueOnce({ id: 'agt_c', displayId: 'AGT-C' });

    await commitImport('agents', 'imp_1', 'usr_admin');

    expect(agents.createAgent).toHaveBeenCalledTimes(2);
    expect(agents.createAgent.mock.calls.map(([input]) => (input as { mobile: string }).mobile)).toEqual(['+919000000001', '+919000000003']);
    expect(repository.finishCommit).toHaveBeenCalledWith('imp_1', expect.objectContaining({ createdCount: 3, invalidCount: 0 }), expect.any(Date));
  });

  it('is refused twice, and refused after a revoke', async () => {
    repository.findImport.mockResolvedValue({ ...validated('ADVERTISER', []), status: 'COMMITTED' });
    await expect(commitImport('advertisers', 'imp_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    repository.findImport.mockResolvedValue({ ...validated('ADVERTISER', []), status: 'REVOKED' });
    await expect(commitImport('advertisers', 'imp_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.finishCommit).not.toHaveBeenCalled();
    expect(advertisers.registerAdvertiser).not.toHaveBeenCalled();
  });

  it('404s an id under the wrong party', async () => {
    repository.findImport.mockResolvedValue(null);
    await expect(commitImport('agents', 'imp_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.findImport).toHaveBeenCalledWith('AGENT', 'imp_1');
  });

  it('revokes only an uncommitted import', async () => {
    repository.findImport.mockResolvedValue(validated('PRINT_PARTNER', []));
    repository.setStatus.mockResolvedValue({ ...validated('PRINT_PARTNER', []), status: 'REVOKED' });
    await expect(revokeImport('print-partners', 'imp_1', 'usr_admin')).resolves.toMatchObject({ status: 'REVOKED' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'PARTY_IMPORT_REVOKED', expect.objectContaining({ targetId: 'imp_1', metadata: { party: 'PRINT_PARTNER' } }));
    repository.findImport.mockResolvedValue({ ...validated('PRINT_PARTNER', []), status: 'COMMITTED' });
    await expect(revokeImport('print-partners', 'imp_1', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reports the rows as CSV, outcome and message first, then the party\'s columns', async () => {
    repository.findImport.mockResolvedValue(
      validated('EMPLOYEE', [
        { rowNumber: 2, outcome: 'MERGED', targetId: 'emp_1', message: 'Merges', data: { mobile: '+919876543210', name: 'Meera', region: 'West' } },
        { rowNumber: 3, outcome: 'INVALID', targetId: null, message: 'mobile is required', data: { mobile: '' } },
      ] as Row[]),
    );
    const csv = await importReportCsv('employees', 'imp_1');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('rowNumber,outcome,message,targetId,name,mobile,email,department,designation,region,workMode,employmentType');
    expect(lines[1]).toBe('2,MERGED,Merges,emp_1,Meera,+919876543210,,,,West,,');
    expect(lines[2]).toContain('3,INVALID,mobile is required,');
    expect(lines).toHaveLength(3);
  });
});
