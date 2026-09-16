import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 07, wave 3 — one dispute domain for three personas and the desk.
 *
 * What is pinned: the parties come off the order, never off the form; the
 * number comes off the identifiers counter; every state change tells the
 * other side; a decision records a credit and moves nothing (DR 04), and the
 * release is the separate human step that moves the wallet once, idempotently.
 */

const { repository, identifiers, users, notifications, wallets } = vi.hoisted(() => ({
  repository: {
    findManyForUser: vi.fn(),
    findById: vi.fn(),
    findSummaryById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    addMessage: vi.fn(),
    addEvidence: vi.fn(),
    findQueue: vi.fn(),
    summary: vi.fn(),
    findOrderParties: vi.fn(),
    partyIdsForUser: vi.fn(),
    findEvidenceByFileId: vi.fn(),
    findPartiesByDisputeIds: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  users: { getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() },
  notifications: { createNotification: vi.fn() },
  wallets: { ensureWallet: vi.fn(), move: vi.fn() },
}));

vi.mock('../prisma-disputes.repository', () => ({ prismaDisputesRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);
vi.mock('../../wallets', () => wallets);
// Lot D: the re-install and the fraud link are read through these; neither is exercised here.
vi.mock('../../order-milestones', () => ({ raiseReinstallMilestone: vi.fn(), findMilestoneStatuses: vi.fn().mockResolvedValue([]) }));
vi.mock('../../fraud', () => ({ findOpenFraudCasesForDisputes: vi.fn().mockResolvedValue([]) }));

import {
  addMessage,
  getVisibleDispute,
  listMine,
  OPS_AUTHOR,
  partiesFor,
  raiseDispute,
  rateResolution,
  releaseCredit,
  reopen,
  resolve,
  setStatus,
  disputePartiesForEvidenceFile,
  evidenceFileIdOf,
} from '../disputes.service';
import { agentStateOf } from '../disputes.types';

const advertiser = { sub: 'usr_adv', roles: ['ADVERTISER'] };
const publisher = { sub: 'usr_pub', roles: ['PUBLISHER'] };
const agent = { sub: 'usr_agt', roles: ['AGENT_PUBLISHER'] };
const admin = { sub: 'usr_admin', roles: ['ADMIN'] };
const stranger = { sub: 'usr_x', roles: ['PUBLISHER'] };

const order = {
  id: 'ord_1',
  status: 'COMPLETED',
  campaignName: 'Monsoon sale',
  listingId: 'lst_1',
  listingTitle: 'Warehouse Gate 2, Koramangala',
  advertiserUserId: 'usr_adv',
  publisherUserId: 'usr_pub',
  agentUserId: 'usr_agt',
};

const now = new Date('2026-09-11T06:00:00.000Z');

const base = {
  id: 'dsp_1',
  displayId: 'DSP-1109-2601',
  raisedByUserId: 'usr_adv',
  raisedAs: 'ADVERTISER',
  againstParty: 'PUBLISHER',
  againstUserId: 'usr_pub',
  orderId: 'ord_1',
  listingId: 'lst_1',
  reason: 'PROOF_REJECTED',
  detail: 'The after photo shows the wrong wall.',
  amountClaimed: '1200.00',
  status: 'OPEN',
  reviewStartedAt: null,
  resolvedAt: null,
  creditedAmount: null,
  creditStatus: 'NONE',
  reopenUntil: null,
  createdAt: new Date('2026-09-10T06:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  identifiers.allocateIdentifier.mockResolvedValue('DSP-1109-2601');
  users.listAdminUserIds.mockResolvedValue(['usr_admin']);
  users.getUserDisplayName.mockResolvedValue('Meera S');
  repository.findOrderParties.mockResolvedValue(order);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'dsp_1', ...data }));
  // T-B: a desk write answers the detail view, re-read after the update —
  // the read answers what the update wrote, with the order card beside it.
  repository.update.mockImplementation(async (id: string, data: Record<string, unknown>) => {
    const row = { ...base, id, ...data };
    repository.findById.mockResolvedValue({ ...row, order, raisedBy: { id: 'usr_adv', name: 'Meera S' }, messages: [], evidence: [] });
    return row;
  });
  repository.addMessage.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'dm_1', ...data }));
  repository.addEvidence.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'de_1', ...data }));
  repository.findSummaryById.mockResolvedValue(base);
  repository.partyIdsForUser.mockResolvedValue({ publisherId: null, advertiserId: 'adv_1', agentId: null });
  wallets.ensureWallet.mockResolvedValue({ id: 'wal_1' });
  wallets.move.mockResolvedValue({ entry: { id: 'we_1' }, ledgerTransactionId: 'lt_1', created: true });
});

describe('who a case is between', () => {
  it('reads the raiser off the order and points the case at the other side', () => {
    expect(partiesFor(advertiser, order, 'PROOF_REJECTED')).toEqual({ raisedAs: 'ADVERTISER', againstParty: 'PUBLISHER', againstUserId: 'usr_pub' });
    expect(partiesFor(publisher, order, 'DAMAGE')).toEqual({ raisedAs: 'PUBLISHER', againstParty: 'AGENT', againstUserId: 'usr_agt' });
    expect(partiesFor(publisher, { ...order, agentUserId: null }, 'DAMAGE')).toEqual({ raisedAs: 'PUBLISHER', againstParty: 'ADVERTISER', againstUserId: 'usr_adv' });
    expect(partiesFor(agent, order, 'WRONG_LOCATION')).toEqual({ raisedAs: 'AGENT', againstParty: 'PUBLISHER', againstUserId: 'usr_pub' });
  });

  it('a payout complaint is with ADX whoever raises it, and a stranger to the order is refused', () => {
    expect(partiesFor(agent, order, 'PAYOUT_ISSUE')).toEqual({ raisedAs: 'AGENT', againstParty: 'ADX', againstUserId: null });
    expect(() => partiesFor(stranger, order, 'OTHER')).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

describe('raising a case', () => {
  it('mints DSP- off the counter, sets the SLA, attaches the evidence, and tells ADX and the other party', async () => {
    const dispute = await raiseDispute(
      advertiser,
      { orderId: 'ord_1', reason: 'PROOF_REJECTED', detail: base.detail, amountClaimed: '1200.00', evidence: [{ url: 'https://cdn.adx.in/u/a.jpg', kind: 'IMG', fileName: 'a.jpg' }] },
      now,
    );
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('DISPUTE');
    expect(dispute).toMatchObject({ displayId: 'DSP-1109-2601', raisedAs: 'ADVERTISER', againstParty: 'PUBLISHER', againstUserId: 'usr_pub', listingId: 'lst_1', amountClaimed: '1200.00' });
    expect((dispute as { slaDueAt: Date }).slaDueAt.toISOString()).toBe('2026-09-14T06:00:00.000Z');
    expect(repository.addEvidence).toHaveBeenCalledWith(expect.objectContaining({ disputeId: 'dsp_1', uploadedByUserId: 'usr_adv', url: 'https://cdn.adx.in/u/a.jpg' }));
    const told = notifications.createNotification.mock.calls.map((call) => call[0]);
    expect(told.map((n) => n.userId).sort()).toEqual(['usr_admin', 'usr_pub']);
    expect(told.every((n) => n.type === 'DISPUTE' && n.subtitle === 'DSP-1109-2601')).toBe(true);
  });

  it('refuses an order that does not exist', async () => {
    repository.findOrderParties.mockResolvedValueOnce(null);
    await expect(raiseDispute(advertiser, { orderId: 'nope', reason: 'OTHER', detail: 'x'.repeat(12), evidence: [] })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the list and the read', () => {
  it('counts the strip by the agent projection and hands money out as strings', async () => {
    repository.findManyForUser.mockResolvedValue([
      { ...base, order: null, _count: { messages: 1, evidence: 0 } },
      { ...base, id: 'dsp_2', status: 'AWAITING_RESPONSE', order: null, _count: { messages: 0, evidence: 2 } },
      { ...base, id: 'dsp_3', status: 'REJECTED', amountClaimed: null, order: null, _count: { messages: 0, evidence: 0 } },
    ]);
    const mine = await listMine(advertiser);
    expect(mine.counts).toEqual({ open: 1, underReview: 1, resolved: 1 });
    expect(mine.disputes[0]).toMatchObject({ agentState: 'OPEN', amountClaimed: '1200.00', messageCount: 1, evidenceCount: 0 });
    expect(mine.disputes[2]).toMatchObject({ agentState: 'RESOLVED', amountClaimed: null });
  });

  it('is visible to the raiser, the other party and ADX, and not found for anyone else', async () => {
    repository.findById.mockResolvedValue({ ...base, order: null, raisedBy: { id: 'usr_adv', name: 'Meera S' }, messages: [], evidence: [] });
    expect(await getVisibleDispute('dsp_1', advertiser)).toMatchObject({ id: 'dsp_1', agentState: 'OPEN' });
    expect(await getVisibleDispute('dsp_1', publisher)).toMatchObject({ id: 'dsp_1' });
    expect(await getVisibleDispute('dsp_1', admin)).toMatchObject({ id: 'dsp_1' });
    expect(await getVisibleDispute('dsp_1', stranger)).toBeNull();
    expect(await getVisibleDispute('dsp_1', agent)).toBeNull();
  });

  it('projects six statuses onto the agent’s three chips', () => {
    expect(['OPEN', 'UNDER_REVIEW', 'AWAITING_RESPONSE', 'ESCALATED', 'RESOLVED', 'REJECTED'].map((s) => agentStateOf(s as never))).toEqual([
      'OPEN', 'UNDER_REVIEW', 'UNDER_REVIEW', 'UNDER_REVIEW', 'RESOLVED', 'RESOLVED',
    ]);
  });
});

describe('the thread', () => {
  it('the desk writes as ADX Ops and both parties hear about it', async () => {
    const message = await addMessage('dsp_1', admin, 'Upload a wider angle showing the full wall.');
    expect(message).toMatchObject({ authorName: OPS_AUTHOR, isFromOps: true });
    expect(notifications.createNotification.mock.calls.map((call) => call[0].userId).sort()).toEqual(['usr_adv', 'usr_pub']);
  });

  it('a party writes under their own name; ADX and the other side are told, they are not', async () => {
    const message = await addMessage('dsp_1', advertiser, 'On it. Will upload tonight.');
    expect(message).toMatchObject({ authorName: 'Meera S', isFromOps: false });
    expect(notifications.createNotification.mock.calls.map((call) => call[0].userId).sort()).toEqual(['usr_admin', 'usr_pub']);
  });

  it('a stranger is refused', async () => {
    await expect(addMessage('dsp_1', stranger, 'hi')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the desk moving a case', () => {
  it('requesting evidence starts the review clock, posts the note as ADX Ops, and tells the parties', async () => {
    const updated = await setStatus('dsp_1', admin, 'AWAITING_RESPONSE', 'Your after photo is too tight.', now);
    expect(updated).toMatchObject({ status: 'AWAITING_RESPONSE', statusNote: 'Your after photo is too tight.', reviewStartedAt: now });
    // T-B: the answer is the detail view — the order card and the clock ride on it
    expect(updated).toMatchObject({ order: expect.objectContaining({ id: 'ord_1', campaignName: 'Monsoon sale' }), sla: expect.objectContaining({ paused: true }), agentState: 'UNDER_REVIEW' });
    expect(repository.addMessage).toHaveBeenCalledWith(expect.objectContaining({ authorName: OPS_AUTHOR, isFromOps: true, body: 'Your after photo is too tight.' }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', title: 'ADX Ops needs something from you' }));
  });

  it('will not move a decided case, and only ADX moves one at all', async () => {
    repository.findSummaryById.mockResolvedValueOnce({ ...base, status: 'RESOLVED' });
    await expect(setStatus('dsp_1', admin, 'UNDER_REVIEW', 'x')).rejects.toMatchObject({ statusCode: 409 });
    await expect(setStatus('dsp_1', advertiser, 'UNDER_REVIEW', 'x')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the decision (decision 2: nothing moves money by itself)', () => {
  it('a partial credit is recorded as pending and no wallet moves', async () => {
    const updated = await resolve('dsp_1', admin, { outcome: 'PARTIAL_CREDIT', note: 'Reinstall approved at no cost.', creditAmount: '450.00' }, now);
    expect(updated).toMatchObject({ status: 'RESOLVED', outcome: 'PARTIAL_CREDIT', creditedAmount: '450.00', creditStatus: 'PENDING', resolvedByUserId: 'usr_admin' });
    // T-B: the detail view — order card, thread, fraud link, reinstall state
    expect(updated).toMatchObject({ order: expect.objectContaining({ id: 'ord_1' }), messages: [], openFraudCase: null, reinstallStatus: null });
    expect((updated as { reopenUntil: Date }).reopenUntil.toISOString()).toBe('2026-09-18T06:00:00.000Z');
    expect(wallets.move).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', title: 'Dispute resolved', message: expect.stringContaining('₹450.00 credit approved') }));
  });

  it('a full credit defaults to the amount claimed, and a credit above it is refused', async () => {
    const updated = await resolve('dsp_1', admin, { outcome: 'FULL_CREDIT', note: 'Refunded.' }, now);
    expect(updated).toMatchObject({ creditedAmount: '1200.00', creditStatus: 'PENDING' });
    await expect(resolve('dsp_1', admin, { outcome: 'PARTIAL_CREDIT', note: 'x', creditAmount: '1500.00' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('no fault closes the case as rejected with nothing owed', async () => {
    const updated = await resolve('dsp_1', admin, { outcome: 'NO_FAULT', note: 'The install matches the brief.' }, now);
    expect(updated).toMatchObject({ status: 'REJECTED', creditedAmount: null, creditStatus: 'NONE' });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Dispute closed' }));
  });
});

describe('finance releasing the credit', () => {
  const pending = { ...base, status: 'RESOLVED', outcome: 'PARTIAL_CREDIT', creditedAmount: '450.00', creditStatus: 'PENDING' };

  it('moves the wallet once, as a refund against revenue for an advertiser, and tells them', async () => {
    repository.findSummaryById.mockResolvedValue(pending);
    const updated = await releaseCredit('dsp_1', admin, now);
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' }, 'Advertiser wallet');
    expect(wallets.move).toHaveBeenCalledWith(expect.objectContaining({
      walletId: 'wal_1',
      amount: '450.00',
      entryType: 'REFUND',
      ledgerKind: 'REFUND',
      idempotencyKey: 'dispute-credit:dsp_1',
      counterLegs: [expect.objectContaining({ accountCode: 'platform:revenue', amount: '-450.00' })],
      createdByUserId: 'usr_admin',
    }));
    expect(updated).toMatchObject({ creditStatus: 'RELEASED', creditReleasedById: 'usr_admin', creditWalletEntryId: 'we_1' });
    // T-B: the detail view — the order card beside the released credit
    expect(updated).toMatchObject({ order: expect.objectContaining({ id: 'ord_1' }), raisedBy: { id: 'usr_adv', name: 'Meera S' }, sla: expect.objectContaining({ breached: false }) });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', title: 'Credit released' }));
  });

  it('a publisher is adjusted against payables; a released credit is a no-op; no credit is a conflict', async () => {
    repository.findSummaryById.mockResolvedValueOnce({ ...pending, raisedAs: 'PUBLISHER', raisedByUserId: 'usr_pub' });
    repository.partyIdsForUser.mockResolvedValueOnce({ publisherId: 'pub_1', advertiserId: null, agentId: null });
    await releaseCredit('dsp_1', admin, now);
    expect(wallets.move).toHaveBeenLastCalledWith(expect.objectContaining({ entryType: 'ADJUSTMENT', counterLegs: [expect.objectContaining({ accountCode: 'platform:payables' })] }));

    repository.findSummaryById.mockResolvedValueOnce({ ...pending, creditStatus: 'RELEASED' });
    await releaseCredit('dsp_1', admin, now);
    expect(wallets.move).toHaveBeenCalledTimes(1);

    repository.findSummaryById.mockResolvedValueOnce({ ...base, status: 'RESOLVED', creditStatus: 'NONE' });
    await expect(releaseCredit('dsp_1', admin, now)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('reopening', () => {
  const decided = { ...base, status: 'RESOLVED', reopenUntil: new Date('2026-09-18T06:00:00.000Z') };

  it('the raiser may, inside the window, and ADX is told', async () => {
    repository.findSummaryById.mockResolvedValue(decided);
    const updated = await reopen('dsp_1', advertiser, now);
    expect(updated).toMatchObject({ status: 'UNDER_REVIEW', reopenUntil: null });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_admin', title: 'A case was reopened' }));
  });

  it('not after the window, not the other party, not an open case', async () => {
    repository.findSummaryById.mockResolvedValueOnce(decided);
    await expect(reopen('dsp_1', advertiser, new Date('2026-09-19T06:00:00.000Z'))).rejects.toMatchObject({ statusCode: 409 });
    repository.findSummaryById.mockResolvedValueOnce(decided);
    await expect(reopen('dsp_1', publisher, now)).rejects.toMatchObject({ statusCode: 403 });
    repository.findSummaryById.mockResolvedValueOnce(base);
    await expect(reopen('dsp_1', advertiser, now)).rejects.toMatchObject({ statusCode: 409 });
  });
});

/* DR 07's RATE RESOLUTION: the raiser scores a decided case, once. */
describe('rating the resolution', () => {
  const decided = { ...base, status: 'RESOLVED', reopenUntil: null, resolutionRating: null };

  it('records the score and the moment, from the raiser, on a decided case', async () => {
    repository.findSummaryById.mockResolvedValue(decided);
    await rateResolution('dsp_1', advertiser, { rating: 4, note: 'Fair, a bit slow' }, now);
    expect(repository.update).toHaveBeenCalledWith('dsp_1', { resolutionRating: 4, resolutionRatingNote: 'Fair, a bit slow', resolutionRatedAt: now });
  });

  it('refuses an open case, a second score, and the other party', async () => {
    repository.findSummaryById.mockResolvedValueOnce(base);
    await expect(rateResolution('dsp_1', advertiser, { rating: 5 }, now)).rejects.toMatchObject({ statusCode: 409 });
    repository.findSummaryById.mockResolvedValueOnce({ ...decided, resolutionRating: 3 });
    await expect(rateResolution('dsp_1', advertiser, { rating: 5 }, now)).rejects.toMatchObject({ statusCode: 409 });
    repository.findSummaryById.mockResolvedValueOnce(decided);
    await expect(rateResolution('dsp_1', publisher, { rating: 5 }, now)).rejects.toMatchObject({ statusCode: 403 });
  });
});

/* Lot F: the evidence-file door. `uploads` asks, through bootstrap's port,
   who the case a DISPUTE_EVIDENCE file sits on is between. */
describe('the parties behind an evidence file', () => {
  const evidence = (disputeId: string, fileId: string, suffix = '') => ({ disputeId, url: `https://adx.local/api/v1/files/${fileId}${suffix}` });

  it('names the raiser and the party against, across every case the file is on, once each — each case resolved by its own disputeId', async () => {
    repository.findEvidenceByFileId.mockResolvedValue([evidence('dsp_1', 'f1'), evidence('dsp_2', 'f1', '?download=1'), evidence('dsp_1', 'f1')]);
    repository.findPartiesByDisputeIds.mockResolvedValue([
      { id: 'dsp_1', raisedByUserId: 'usr_adv', againstUserId: 'usr_pub' },
      { id: 'dsp_2', raisedByUserId: 'usr_adv', againstUserId: null },
    ]);
    await expect(disputePartiesForEvidenceFile('f1', ['usr_adv'])).resolves.toEqual(['usr_adv', 'usr_pub']);
    expect(repository.findEvidenceByFileId).toHaveBeenCalledWith('f1');
    // The two cases, once each, by id — never a second search over the URL text.
    expect(repository.findPartiesByDisputeIds).toHaveBeenCalledWith(['dsp_1', 'dsp_2']);
  });

  /* E9 (the E7 verifier): `f1` is not `f12`. A row whose URL merely contains
     the id as a substring belongs to another file, and its case must not open. */
  it('matches the file id exactly, not as a substring of another file id', async () => {
    repository.findEvidenceByFileId.mockResolvedValue([evidence('dsp_other', 'f12'), evidence('dsp_other2', 'f1a'), evidence('dsp_mine', 'f1', '#page=2')]);
    repository.findPartiesByDisputeIds.mockResolvedValue([{ id: 'dsp_mine', raisedByUserId: 'usr_adv', againstUserId: 'usr_pub' }]);
    await expect(disputePartiesForEvidenceFile('f1', ['usr_adv'])).resolves.toEqual(['usr_adv', 'usr_pub']);
    expect(repository.findPartiesByDisputeIds).toHaveBeenCalledWith(['dsp_mine']);

    expect(evidenceFileIdOf('https://adx.local/api/v1/files/f1')).toBe('f1');
    expect(evidenceFileIdOf('https://adx.local/api/v1/files/f1/thumb?x=1')).toBe('f1');
    expect(evidenceFileIdOf('https://adx.local/api/v1/files/f12')).toBe('f12');
    expect(evidenceFileIdOf('https://cdn.example.com/photo.jpg')).toBeNull();
  });

  it('is empty for a file no case holds, and asks for no parties', async () => {
    repository.findEvidenceByFileId.mockResolvedValue([]);
    await expect(disputePartiesForEvidenceFile('nope', ['usr_adv'])).resolves.toEqual([]);
    repository.findEvidenceByFileId.mockResolvedValue([evidence('dsp_other', 'nope2')]);
    await expect(disputePartiesForEvidenceFile('nope', ['usr_adv'])).resolves.toEqual([]);
    expect(repository.findPartiesByDisputeIds).not.toHaveBeenCalled();
  });

  /* An evidence URL is text the raiser typed: a stranger who attaches somebody
     else's /files/:id to a case of their own must not become its reader. */
  it("ignores a case the file's own people are not a party to", async () => {
    repository.findEvidenceByFileId.mockResolvedValue([evidence('dsp_x', 'f1'), evidence('dsp_adv', 'f1'), evidence('dsp_z', 'f1')]);
    repository.findPartiesByDisputeIds.mockResolvedValue([
      { id: 'dsp_x', raisedByUserId: 'usr_x', againstUserId: 'usr_y' },
      { id: 'dsp_adv', raisedByUserId: 'usr_adv', againstUserId: 'usr_pub' },
      { id: 'dsp_z', raisedByUserId: 'usr_z', againstUserId: 'usr_pub' },
    ]);
    // Owned by usr_adv: the stranger's case (usr_x → usr_y) opens nothing; the case against usr_pub counts when usr_pub holds it.
    await expect(disputePartiesForEvidenceFile('f1', ['usr_adv'])).resolves.toEqual(['usr_adv', 'usr_pub']);
    await expect(disputePartiesForEvidenceFile('f1', ['usr_pub'])).resolves.toEqual(['usr_adv', 'usr_pub', 'usr_z']);
    await expect(disputePartiesForEvidenceFile('f1', ['usr_nobody'])).resolves.toEqual([]);
  });
});
