import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot E (Q97): a revised card and the listings it leaves under the floor.
 *
 * Approving a card used to supersede the old one and stop there — an ACTIVE
 * listing priced fine under v3 could sit under v4's floor for ever, because
 * the gate only ever ran at publish. Now approving raises one CARD_REVISION
 * case per affected ACTIVE listing, with a grace the publisher is told about,
 * and rejecting such a case unpublishes the listing through `listings` —
 * unless an order is running on it, in which case the case is held with a
 * note and nothing goes dark under a paying advertiser.
 */

const { repository, port, logActivity, createNotification } = vi.hoisted(() => ({
  repository: {
    findGateSubject: vi.fn(),
    effectiveEntry: vi.fn(),
    findLiveApprovalForListing: vi.fn(),
    createApproval: vi.fn(),
    findApproval: vi.fn(),
    decideApproval: vi.fn(),
    holdApproval: vi.fn(),
    findCard: vi.fn(),
    setStatus: vi.fn(),
    activeCardsOverlapping: vi.fn(),
    activeListingsPricedBy: vi.fn(),
    hasNonTerminalOrder: vi.fn(),
    listApprovals: vi.fn(),
    listApprovalsPage: vi.fn(),
  },
  port: { unpublish: vi.fn() },
  logActivity: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('../prisma-rate-cards.repository', () => ({ prismaRateCardsRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity,
}));
vi.mock('../../notifications', () => ({ createNotification }));

import { approveCard, belowFloorFlags, cardImpact, cardImpactDryRun, decideApproval, listApprovals, listApprovalsPage, raisePriceCase } from '../rate-cards.service';
import { registerListingEnforcementPort, resetListingEnforcementPort } from '../listing-enforcement.port';

/** v4 of the Bengaluru card: grade A hoardings at 10,000 a day, floor 82% = 8,200. */
const card = (over: Record<string, unknown> = {}) => ({
  id: 'rc_4',
  name: 'Bengaluru Metro Premium',
  version: 4,
  status: 'PENDING_APPROVAL',
  cityId: 'city_1',
  floorPct: new Decimal('0.82'),
  graceDays: 14,
  roundingRupees: 100,
  entries: [
    { id: 'e1', mediaTypeId: 'mt_1', grade: 'A', ratePerDay: new Decimal('10000.00') },
    { id: 'e2', mediaTypeId: 'mt_1', grade: 'B', ratePerDay: null },
  ],
  ...over,
});

const subject = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  title: 'MG Road hoarding',
  status: 'ACTIVE',
  mediaTypeId: 'mt_1',
  cityId: 'city_1',
  city: 'Bengaluru',
  rateGrade: 'A',
  ratePerDay: new Decimal('7000.00'),
  publisherId: 'pub_1',
  publisherUserId: 'usr_pub',
  ...over,
});

const approval = (over: Record<string, unknown> = {}) => ({
  id: 'pa_1',
  listingId: 'lst_1',
  rateCardId: 'rc_4',
  status: 'PENDING',
  source: 'CARD_REVISION',
  graceUntil: new Date(Date.now() - 1000),
  requestedRatePerDay: new Decimal('7000.00'),
  cardRatePerDay: new Decimal('10000.00'),
  floorRatePerDay: new Decimal('8200.00'),
  reason: null,
  requestedById: 'usr_admin',
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  heldByRunningOrder: false,
  createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  registerListingEnforcementPort(port);
  repository.findCard.mockResolvedValue(card());
  repository.activeCardsOverlapping.mockResolvedValue([]);
  repository.setStatus.mockImplementation(async (id: string, status: string) => ({ ...card({ id, status }) }));
  repository.activeListingsPricedBy.mockResolvedValue([subject(), subject({ id: 'lst_2', ratePerDay: new Decimal('9000.00') })]);
  repository.findLiveApprovalForListing.mockResolvedValue(null);
  repository.createApproval.mockImplementation(async (data: Record<string, unknown>) => ({ id: `pa_${data['listingId']}`, ...data }));
  repository.effectiveEntry.mockResolvedValue(null);
  repository.hasNonTerminalOrder.mockResolvedValue(false);
  repository.decideApproval.mockImplementation(async (id: string, status: string, decidedById: string, note?: string) =>
    approval({ id, status, decidedById, decisionNote: note ?? null })
  );
  repository.holdApproval.mockImplementation(async (id: string, note: string) => approval({ id, decisionNote: note, heldByRunningOrder: true }));
  createNotification.mockResolvedValue(undefined);
  port.unpublish.mockResolvedValue(undefined);
});

afterEach(() => {
  resetListingEnforcementPort();
});

describe('the impact of a card', () => {
  it('lists the ACTIVE listings this card would leave under its floor, with the shortfall', async () => {
    const impact = await cardImpact('rc_4');
    expect(impact.rows).toEqual([
      expect.objectContaining({
        listingId: 'lst_1',
        ratePerDay: '7000.00',
        cardRate: '10000.00',
        floor: '8200.00',
        shortfall: '1200.00',
        liveCase: null,
      }),
    ]);
    // lst_2 at 9,000 is above the 8,200 floor and is not in the list.
    expect(impact.rows.map((row) => row.listingId)).not.toContain('lst_2');
  });

  it('measures against this card, whatever the gate would say today', async () => {
    // A listing at grade B, which this card does not sell: not covered, not affected.
    repository.activeListingsPricedBy.mockResolvedValue([subject({ rateGrade: 'B' })]);
    expect((await cardImpact('rc_4')).rows).toEqual([]);
  });

  it('shows the case already standing on a listing rather than counting it twice', async () => {
    repository.findLiveApprovalForListing.mockResolvedValue({ id: 'pa_old', status: 'APPROVED', source: 'PUBLISH_REQUEST' });
    const impact = await cardImpact('rc_4');
    expect(impact.rows[0]?.liveCase).toEqual({ id: 'pa_old', status: 'APPROVED', source: 'PUBLISH_REQUEST' });
  });
});

describe('approving a revised card', () => {
  it('raises one CARD_REVISION case per affected listing, frozen, with the grace, and tells the publisher', async () => {
    const before = Date.now();
    await approveCard('rc_4', 'usr_admin');

    expect(repository.createApproval).toHaveBeenCalledTimes(1);
    const raised = repository.createApproval.mock.calls[0]![0];
    expect(raised).toMatchObject({
      listingId: 'lst_1',
      rateCardId: 'rc_4',
      source: 'CARD_REVISION',
      requestedById: 'usr_admin',
    });
    expect(raised.requestedRatePerDay.toString()).toBe('7000');
    expect(raised.cardRatePerDay.toString()).toBe('10000');
    expect(raised.floorRatePerDay.toString()).toBe('8200');
    // Fourteen days, from the card's own graceDays.
    const days = (raised.graceUntil.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);

    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'usr_pub',
        type: 'SYSTEM',
        message: expect.stringContaining('Raise the rate or ask ADX to keep it'),
      })
    );
    expect(logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'RATE_CARD_IMPACT_RAISED',
      expect.objectContaining({ targetType: 'RateCard', targetId: 'rc_4', metadata: expect.objectContaining({ raised: 1 }) })
    );
  });

  it('skips a listing that already has a live case', async () => {
    repository.findLiveApprovalForListing.mockResolvedValue({ id: 'pa_old', status: 'PENDING', source: 'PUBLISH_REQUEST' });
    await approveCard('rc_4', 'usr_admin');
    expect(repository.createApproval).not.toHaveBeenCalled();
  });

  it('still supersedes what it replaces, and goes ACTIVE before it measures anything', async () => {
    repository.activeCardsOverlapping.mockResolvedValue([{ id: 'rc_3' }]);
    await approveCard('rc_4', 'usr_admin');
    expect(repository.setStatus).toHaveBeenCalledWith('rc_3', 'SUPERSEDED');
    expect(repository.setStatus).toHaveBeenCalledWith('rc_4', 'ACTIVE', { approvedById: 'usr_admin' });
  });
});

describe('deciding a CARD_REVISION case', () => {
  beforeEach(() => {
    repository.findApproval.mockResolvedValue(approval());
    repository.findGateSubject.mockResolvedValue(subject());
  });

  it('approving keeps the price, as it always did', async () => {
    const decided = await decideApproval('pa_1', true, 'usr_admin', 'fine');
    expect(decided.status).toBe('APPROVED');
    expect(port.unpublish).not.toHaveBeenCalled();
  });

  it('will not reject while the grace the publisher was promised is still running', async () => {
    repository.findApproval.mockResolvedValue(approval({ graceUntil: new Date(Date.now() + 86_400_000) }));
    await expect(decideApproval('pa_1', false, 'usr_admin')).rejects.toMatchObject({
      statusCode: 409,
      code: 'GRACE_PERIOD_RUNNING',
    });
    expect(repository.decideApproval).not.toHaveBeenCalled();
  });

  it('rejecting after the grace unpublishes the listing through the listing module', async () => {
    const decided = await decideApproval('pa_1', false, 'usr_admin', 'no exception');
    expect(port.unpublish).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'lst_1', actorUserId: 'usr_admin', reason: expect.stringContaining('8200.00') })
    );
    expect(decided.status).toBe('REJECTED');
  });

  it('never unpublishes a listing with a running order: the case stays PENDING with a note', async () => {
    repository.hasNonTerminalOrder.mockResolvedValue(true);
    const held = await decideApproval('pa_1', false, 'usr_admin', 'no exception');
    expect(port.unpublish).not.toHaveBeenCalled();
    expect(repository.decideApproval).not.toHaveBeenCalled();
    // E7-2: the column carries the hold; the note is prose, no prefix.
    expect(repository.holdApproval).toHaveBeenCalledWith('pa_1', expect.stringContaining('An order is still running'));
    expect(repository.holdApproval).toHaveBeenCalledWith('pa_1', expect.not.stringContaining('HELD_BY_RUNNING_ORDER'));
    expect(held).toMatchObject({ status: 'PENDING', heldByRunningOrder: true });
  });

  it('E10-2: the desk filters by source and listing, and pages on the list contract when asked', async () => {
    repository.listApprovals.mockResolvedValue([approval({ id: 'pa_rev', source: 'CARD_REVISION' })]);
    const bare = await listApprovals({ status: 'PENDING', source: 'CARD_REVISION', listingId: 'lst_1' });
    expect(repository.listApprovals).toHaveBeenCalledWith({ status: 'PENDING', source: 'CARD_REVISION', listingId: 'lst_1' });
    expect(bare.map((row) => row.id)).toEqual(['pa_rev']);

    repository.listApprovalsPage.mockResolvedValue({
      items: [approval({ id: 'pa_held', heldByRunningOrder: true }), approval({ id: 'pa_open' })],
      total: 7,
      counts: { PENDING: 5, APPROVED: 1, REJECTED: 1 },
    });
    const page = await listApprovalsPage({ source: 'PUBLISH_REQUEST' }, { page: 2, pageSize: 2 });
    expect(repository.listApprovalsPage).toHaveBeenCalledWith({ source: 'PUBLISH_REQUEST' }, { page: 2, pageSize: 2 });
    expect(page).toMatchObject({ total: 7, page: 2, pageSize: 2, counts: { PENDING: 5, APPROVED: 1, REJECTED: 1 } });
    expect(page.items.map((row) => [row.id, row.heldByRunningOrder])).toEqual([
      ['pa_held', true],
      ['pa_open', false],
    ]);
  });

  it('E7-2: the flag is the column, and the old note prefix is still read for rows held before it existed', async () => {
    repository.listApprovals.mockResolvedValue([
      approval({ id: 'pa_col', heldByRunningOrder: true, decisionNote: 'An order is still running on this listing.' }),
      approval({ id: 'pa_old', heldByRunningOrder: false, decisionNote: 'HELD_BY_RUNNING_ORDER: an order is still running' }),
      approval({ id: 'pa_open', heldByRunningOrder: false, decisionNote: null }),
      approval({ id: 'pa_done', status: 'REJECTED', heldByRunningOrder: true }),
    ]);
    const rows = await listApprovals();
    expect(rows.map((row) => [row.id, row.heldByRunningOrder])).toEqual([
      ['pa_col', true],
      ['pa_old', true],
      ['pa_open', false],
      ['pa_done', false],
    ]);
  });

  it('has nothing to unpublish when the publisher already raised the rate', async () => {
    repository.findGateSubject.mockResolvedValue(subject({ ratePerDay: new Decimal('8500.00') }));
    const decided = await decideApproval('pa_1', false, 'usr_admin');
    expect(port.unpublish).not.toHaveBeenCalled();
    expect(decided.status).toBe('REJECTED');
  });

  it('a plain PUBLISH_REQUEST rejection is a decision on paper and nothing more', async () => {
    repository.findApproval.mockResolvedValue(approval({ source: 'PUBLISH_REQUEST', graceUntil: null }));
    await decideApproval('pa_1', false, 'usr_admin');
    expect(port.unpublish).not.toHaveBeenCalled();
    expect(repository.hasNonTerminalOrder).not.toHaveBeenCalled();
  });
});

describe('the below-floor flag for a list', () => {
  it('answers per listing, false where no card reaches', async () => {
    repository.findGateSubject.mockImplementation(async (id: string) =>
      id === 'lst_1' ? subject() : subject({ id, ratePerDay: new Decimal('9000.00') })
    );
    repository.effectiveEntry.mockResolvedValue({ card: card({ status: 'ACTIVE' }), entry: card().entries[0] });
    await expect(belowFloorFlags(['lst_1', 'lst_2'])).resolves.toEqual({ lst_1: true, lst_2: false });

    repository.effectiveEntry.mockResolvedValue(null);
    await expect(belowFloorFlags(['lst_1'])).resolves.toEqual({ lst_1: false });
  });
});

describe('a case the engine raises', () => {
  /** Lot E (Q125): a BINDING factor above the cap lands here. */
  it('freezes the card in force and carries the rate the factor wanted', async () => {
    repository.findGateSubject.mockResolvedValue(subject());
    repository.effectiveEntry.mockResolvedValue({ card: card({ status: 'ACTIVE' }), entry: card().entries[0] });
    const raised = await raisePriceCase({
      listingId: 'lst_1',
      requestedRatePerDay: '15000.00',
      requestedById: 'usr_admin',
      reason: 'binding factor exceeded cap',
    });
    expect(raised.id).toBe('pa_lst_1');
    const data = repository.createApproval.mock.calls[0]![0];
    expect(data).toMatchObject({ listingId: 'lst_1', rateCardId: 'rc_4', source: 'PUBLISH_REQUEST', reason: 'binding factor exceeded cap' });
    expect(data.requestedRatePerDay.toString()).toBe('15000');
    expect(data.floorRatePerDay.toString()).toBe('8200');
  });

  it('returns the PENDING case already standing rather than doubling it', async () => {
    repository.findGateSubject.mockResolvedValue(subject());
    repository.findLiveApprovalForListing.mockResolvedValue({ id: 'pa_open', status: 'PENDING', source: 'PUBLISH_REQUEST' });
    await expect(
      raisePriceCase({ listingId: 'lst_1', requestedRatePerDay: '15000.00', requestedById: 'usr_admin', reason: 'x' })
    ).resolves.toEqual({ id: 'pa_open' });
    expect(repository.createApproval).not.toHaveBeenCalled();
  });

  it('stands without a card where none reaches, so the case still exists to be decided', async () => {
    repository.findGateSubject.mockResolvedValue(subject());
    repository.effectiveEntry.mockResolvedValue(null);
    await raisePriceCase({ listingId: 'lst_1', requestedRatePerDay: '15000.00', requestedById: 'usr_admin', reason: 'x' });
    expect(repository.createApproval.mock.calls[0]![0]).toMatchObject({ rateCardId: null, cardRatePerDay: null, floorRatePerDay: null });
  });
});

describe('E10-2: the dry run', () => {
  it('measures a draft grid against the card listings without touching the card', async () => {
    // The stored card prices grade A at 10,000 (floor 8,200): lst_1 at 7,000 is under it, lst_2 at 9,000 is not.
    const stored = await cardImpact('rc_4');
    expect(stored.rows.map((row) => row.listingId)).toEqual(['lst_1']);

    // The draft raises grade A to 12,000 with a 90% floor: 10,800 — both listings fall under it.
    const draft = await cardImpactDryRun('rc_4', {
      entries: [{ mediaTypeId: 'mt_1', grade: 'A', ratePerDay: '12000.00' }],
      floorPct: '0.9',
      graceDays: 30,
    });
    expect(draft.card).toMatchObject({ id: 'rc_4', name: 'Bengaluru Metro Premium', version: 4, status: 'PENDING_APPROVAL', graceDays: 30 });
    expect(draft.rows.map((row) => [row.listingId, row.cardRate, row.floor, row.shortfall])).toEqual([
      ['lst_1', '12000.00', '10800.00', '3800.00'],
      ['lst_2', '12000.00', '10800.00', '1800.00'],
    ]);
    // Nothing written, nothing raised.
    expect(repository.setStatus).not.toHaveBeenCalled();
    expect(repository.createApproval).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('keeps the stored floor and grace when the draft names neither, and a null cell prices nothing', async () => {
    const draft = await cardImpactDryRun('rc_4', { entries: [{ mediaTypeId: 'mt_1', grade: 'A', ratePerDay: null }] });
    expect(draft.card.graceDays).toBe(14);
    expect(draft.rows).toEqual([]);
  });

  it('is a 404 for a card that does not exist', async () => {
    repository.findCard.mockResolvedValue(null);
    await expect(cardImpactDryRun('rc_missing', { entries: [] })).rejects.toMatchObject({ statusCode: 404 });
  });
});
