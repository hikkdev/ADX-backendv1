import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q54/Q92/Q121) — fraud as a case object.
 *
 * What is pinned: a case is opened against a real party and numbered FRD-;
 * a CONFIRMED decision applies suspension scopes through the suspension
 * module (default BLOCK_NEW + FREEZE_WALLET, the wallet freeze being the
 * FREEZE_WALLET scope and nothing else) with the case's number as the reason;
 * a DISMISSED decision on a confirmed case lifts exactly what the case
 * applied and nothing the party was carrying before; a decided case is not
 * decided twice; notes and evidence sit on the case; the people on the case
 * hear about the decision.
 */

const { repository, suspension, users, notifications, audit, identifiers, kyc } = vi.hoisted(() => ({
  repository: {
    list: vi.fn(),
    findById: vi.fn(),
    findSummaryById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    addNote: vi.fn(),
    addEvidence: vi.fn(),
    findOpenForDisputes: vi.fn(),
    findOpenForSubject: vi.fn(),
  },
  kyc: { escalateKycForFraudLink: vi.fn(async () => null) },
  suspension: { suspendParty: vi.fn(), reinstateParty: vi.fn(), suspensionOf: vi.fn(), SCOPES_BY_PARTY: {
    LISTING: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL'],
    PUBLISHER: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
    ADVERTISER: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
    AGENT: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
  } },
  users: { userExists: vi.fn(), listAdminUserIds: vi.fn() },
  notifications: { createNotification: vi.fn() },
  audit: { findActivityByMetadata: vi.fn() },
  identifiers: { allocateIdentifier: vi.fn(async () => 'FRD-1209-0001') },
}));

vi.mock('../prisma-fraud.repository', () => ({ prismaFraudRepository: repository }));
vi.mock('../../suspension', () => suspension);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../kyc', () => kyc);

import { addEvidence, addNote, decideCase, escalateCase, getCase, openCase, patchCase } from '../fraud.service';

const now = new Date('2026-09-12T09:00:00.000Z');
const admin = { sub: 'usr_admin', roles: ['ADMIN'] };

const fraudCase = (over: Record<string, unknown> = {}) => ({
  id: 'frd_1',
  displayId: 'FRD-26-0001',
  subjectType: 'PUBLISHER',
  subjectId: 'pub_1',
  kind: 'FAKE_PROOF',
  status: 'OPEN',
  summary: 'Install photos reused across three orders',
  openedByUserId: 'usr_admin',
  assignedToUserId: null,
  disputeId: 'dsp_1',
  decision: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: now,
  ...over,
});

const clean = { partyType: 'PUBLISHER', partyId: 'pub_1', scopes: [], suspendedAt: null, suspensionReason: null, suspendedById: null, name: 'Ramesh', admits: [], events: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  suspension.suspensionOf.mockResolvedValue(clean);
  suspension.suspendParty.mockResolvedValue({ ...clean, scopes: ['BLOCK_NEW', 'FREEZE_WALLET'] });
  suspension.reinstateParty.mockResolvedValue({ ...clean, lifted: ['BLOCK_NEW', 'FREEZE_WALLET'] });
  users.userExists.mockResolvedValue(true);
  users.listAdminUserIds.mockResolvedValue(['usr_admin']);
  notifications.createNotification.mockResolvedValue(undefined);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => fraudCase({ ...data }));
  repository.update.mockImplementation(async (id: string, data: Record<string, unknown>) => fraudCase({ id, ...data }));
  repository.findSummaryById.mockResolvedValue(fraudCase());
  repository.findById.mockResolvedValue({ ...fraudCase(), notes: [], evidence: [] });
  repository.addNote.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'n_1', ...data }));
  repository.addEvidence.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'e_1', ...data }));
  audit.findActivityByMetadata.mockResolvedValue([]);
});

describe('opening a case', () => {
  it('checks the subject exists and writes it against the opener', async () => {
    const created = await openCase(admin, { subjectType: 'PUBLISHER', subjectId: 'pub_1', kind: 'FAKE_PROOF', summary: 'Install photos reused', disputeId: 'dsp_1' });
    expect(suspension.suspensionOf).toHaveBeenCalledWith('PUBLISHER', 'pub_1');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ subjectType: 'PUBLISHER', subjectId: 'pub_1', openedByUserId: 'usr_admin', disputeId: 'dsp_1' }), expect.any(Date));
    // E6: the number comes off the identifiers counter, FRD- series.
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('FRAUD_CASE', expect.any(Date));
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ displayId: 'FRD-1209-0001' }), expect.any(Date));
    expect(created).toMatchObject({ status: 'OPEN' });
  });

  it('refuses a subject that does not exist', async () => {
    suspension.suspensionOf.mockRejectedValue(Object.assign(new Error('nf'), { statusCode: 404 }));
    await expect(openCase(admin, { subjectType: 'AGENT', subjectId: 'agt_x', kind: 'x', summary: 'y' })).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  // Lot G (Q127/142): a case opened against a party with a pending KYC escalates it as FRAUD_LINK — and never fails the open.
  it('tells kyc a case was opened, and still opens when the KYC side fails', async () => {
    await openCase(admin, { subjectType: 'PUBLISHER', subjectId: 'pub_1', kind: 'FAKE_PROOF', summary: 'Install photos reused' });
    expect(kyc.escalateKycForFraudLink).toHaveBeenCalledWith({ subjectType: 'PUBLISHER', subjectId: 'pub_1', caseDisplayId: 'FRD-1209-0001', byUserId: 'usr_admin' });

    kyc.escalateKycForFraudLink.mockRejectedValueOnce(new Error('kyc down'));
    const created = await openCase(admin, { subjectType: 'PUBLISHER', subjectId: 'pub_1', kind: 'FAKE_PROOF', summary: 'Install photos reused' });
    expect(created).toMatchObject({ status: 'OPEN' });
  });
});

describe('escalation (Lot G, Q118)', () => {
  it('marks the case ESCALATED with the note and the time, hands it to the named admin and tells them', async () => {
    const { after } = await escalateCase('frd_1', admin, { note: 'Same PAN on four publishers', toUserId: 'usr_lead' });
    expect(users.userExists).toHaveBeenCalledWith('usr_lead');
    expect(repository.update).toHaveBeenCalledWith('frd_1', { status: 'ESCALATED', escalatedAt: now, escalatedToUserId: 'usr_lead', escalationNote: 'Same PAN on four publishers' });
    expect(after.status).toBe('ESCALATED');
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_lead', title: 'Fraud case escalated to you' }));
  });

  it('falls back to the investigator when nobody is named, and is done once', async () => {
    repository.findSummaryById.mockResolvedValue(fraudCase({ status: 'INVESTIGATING', assignedToUserId: 'usr_inv' }));
    await escalateCase('frd_1', admin, { note: 'Needs a second pair of eyes' });
    expect(repository.update).toHaveBeenCalledWith('frd_1', expect.objectContaining({ status: 'ESCALATED', escalatedToUserId: 'usr_inv' }));

    repository.findSummaryById.mockResolvedValue(fraudCase({ status: 'ESCALATED', escalatedAt: now }));
    await expect(escalateCase('frd_1', admin, { note: 'again' })).rejects.toMatchObject({ statusCode: 409 });
    repository.findSummaryById.mockResolvedValue(fraudCase({ status: 'DISMISSED', decidedAt: now, decidedByUserId: 'usr_admin' }));
    await expect(escalateCase('frd_1', admin, { note: 'late' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('an escalated case still takes notes and is still decided', async () => {
    repository.findSummaryById.mockResolvedValue(fraudCase({ status: 'ESCALATED', escalatedAt: now, escalatedToUserId: 'usr_lead' }));
    await addNote('frd_1', admin, 'Spoke to the lead');
    expect(repository.addNote).toHaveBeenCalled();
    const result = await decideCase('frd_1', admin, { status: 'CONFIRMED', decision: 'Confirmed on the shared PAN.' });
    expect(result.after.status).toBe('CONFIRMED');
    expect(suspension.suspendParty).toHaveBeenCalled();
  });
});

describe('the case file', () => {
  it('reads with the notes, the evidence and the subject’s current suspension', async () => {
    suspension.suspensionOf.mockResolvedValue({ ...clean, scopes: ['BLOCK_NEW'] });
    const file = await getCase('frd_1');
    expect(file).toMatchObject({ id: 'frd_1', notes: [], evidence: [], suspension: { scopes: ['BLOCK_NEW'] } });
  });

  it('takes notes and evidence, and evidence must point at something', async () => {
    await addNote('frd_1', admin, 'Called the publisher');
    expect(repository.addNote).toHaveBeenCalledWith({ caseId: 'frd_1', byUserId: 'usr_admin', body: 'Called the publisher' });
    await addEvidence('frd_1', admin, { kind: 'PHOTO', url: 'https://cdn.adx.in/x.jpg' });
    expect(repository.addEvidence).toHaveBeenCalledWith(expect.objectContaining({ caseId: 'frd_1', kind: 'PHOTO', url: 'https://cdn.adx.in/x.jpg', addedByUserId: 'usr_admin' }));
    await expect(addEvidence('frd_1', admin, { kind: 'PHOTO' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a decided case takes no more notes', async () => {
    repository.findSummaryById.mockResolvedValue(fraudCase({ status: 'DISMISSED', decidedAt: now, decidedByUserId: 'usr_admin' }));
    await expect(addNote('frd_1', admin, 'late')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('working the case', () => {
  it('moves OPEN to INVESTIGATING and assigns an investigator, who is told', async () => {
    await patchCase('frd_1', admin, { status: 'INVESTIGATING', assignedToUserId: 'usr_inv' });
    expect(users.userExists).toHaveBeenCalledWith('usr_inv');
    expect(repository.update).toHaveBeenCalledWith('frd_1', { status: 'INVESTIGATING', assignedToUserId: 'usr_inv' });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_inv', title: 'Fraud case assigned to you' }));
  });

  it('refuses to patch a decided case', async () => {
    repository.findSummaryById.mockResolvedValue(fraudCase({ status: 'CONFIRMED', decidedAt: now, decidedByUserId: 'usr_admin' }));
    await expect(patchCase('frd_1', admin, { status: 'INVESTIGATING' })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the decision', () => {
  it('CONFIRMED applies BLOCK_NEW + FREEZE_WALLET through the suspension module, reasoned with the case number', async () => {
    const result = await decideCase('frd_1', admin, { status: 'CONFIRMED', decision: 'Three orders, same photo.' });

    expect(suspension.suspendParty).toHaveBeenCalledWith('PUBLISHER', 'pub_1', {
      scopes: ['BLOCK_NEW', 'FREEZE_WALLET'],
      reason: 'Fraud case FRD-26-0001',
      byUserId: 'usr_admin',
    });
    // E6: the confirmation writes what it applied on the row.
    expect(repository.update).toHaveBeenCalledWith('frd_1', {
      status: 'CONFIRMED',
      decision: 'Three orders, same photo.',
      decidedByUserId: 'usr_admin',
      decidedAt: now,
      appliedScopes: ['BLOCK_NEW', 'FREEZE_WALLET'],
    });
    expect(result.scopesApplied).toEqual(['BLOCK_NEW', 'FREEZE_WALLET']);
  });

  it('applies only what the party was not already carrying, and only what its type admits', async () => {
    suspension.suspensionOf.mockResolvedValue({ ...clean, scopes: ['BLOCK_NEW'] });
    const result = await decideCase('frd_1', admin, { status: 'CONFIRMED', decision: 'x', scopes: ['BLOCK_NEW', 'FREEZE_WALLET', 'BLOCK_SIGNIN'] });
    expect(result.scopesApplied).toEqual(['FREEZE_WALLET', 'BLOCK_SIGNIN']);

    vi.clearAllMocks();
    suspension.suspensionOf.mockResolvedValue({ ...clean, partyType: 'LISTING', scopes: [] });
    repository.findSummaryById.mockResolvedValue(fraudCase({ subjectType: 'LISTING', subjectId: 'lst_1' }));
    const listing = await decideCase('frd_1', admin, { status: 'CONFIRMED', decision: 'x' });
    expect(suspension.suspendParty).toHaveBeenCalledWith('LISTING', 'lst_1', expect.objectContaining({ scopes: ['BLOCK_NEW'] }));
    expect(listing.scopesApplied).toEqual(['BLOCK_NEW']);
  });

  it('DISMISSED on an open case suspends nothing and lifts nothing', async () => {
    const result = await decideCase('frd_1', admin, { status: 'DISMISSED', decision: 'A duplicate upload, not fraud.' });
    expect(suspension.suspendParty).not.toHaveBeenCalled();
    expect(suspension.reinstateParty).not.toHaveBeenCalled();
    expect(result.scopesApplied).toEqual([]);
    expect(result.scopesLifted).toEqual([]);
  });

  it('DISMISSED after CONFIRMED lifts exactly what this case applied', async () => {
    // E6: read off the row's appliedScopes, not the audit trail.
    repository.findSummaryById.mockResolvedValue(
      fraudCase({ status: 'CONFIRMED', decidedAt: now, decidedByUserId: 'usr_admin', appliedScopes: ['FREEZE_WALLET', 'NOT_A_SCOPE'] }),
    );
    const result = await decideCase('frd_1', admin, { status: 'DISMISSED', decision: 'Overturned on appeal.' });
    expect(audit.findActivityByMetadata).not.toHaveBeenCalled();
    expect(suspension.reinstateParty).toHaveBeenCalledWith('PUBLISHER', 'pub_1', {
      scopes: ['FREEZE_WALLET'],
      reason: 'Fraud case FRD-26-0001 dismissed',
      byUserId: 'usr_admin',
    });
    expect(result.scopesLifted).toEqual(['FREEZE_WALLET']);
  });

  it('a decided case is not decided the same way twice, and a dismissal is final', async () => {
    repository.findSummaryById.mockResolvedValue(fraudCase({ status: 'CONFIRMED', decidedAt: now, decidedByUserId: 'usr_admin' }));
    await expect(decideCase('frd_1', admin, { status: 'CONFIRMED', decision: 'again' })).rejects.toMatchObject({ statusCode: 409 });
    repository.findSummaryById.mockResolvedValue(fraudCase({ status: 'DISMISSED', decidedAt: now, decidedByUserId: 'usr_admin' }));
    await expect(decideCase('frd_1', admin, { status: 'CONFIRMED', decision: 'again' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('tells the opener and the investigator', async () => {
    repository.findSummaryById.mockResolvedValue(fraudCase({ openedByUserId: 'usr_opener', assignedToUserId: 'usr_inv' }));
    await decideCase('frd_1', admin, { status: 'CONFIRMED', decision: 'x' });
    const told = notifications.createNotification.mock.calls.map((call) => call[0].userId).sort();
    expect(told).toEqual(['usr_inv', 'usr_opener']);
  });
});
