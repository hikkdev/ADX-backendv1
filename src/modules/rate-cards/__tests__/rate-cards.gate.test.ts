import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The gate, and the two ways it lets a listing through.
 *
 * A rate card decides whether somebody's inventory can earn, so the interesting
 * cases are the permissive ones. A gate that blocks correctly and also blocks a
 * deployment that has no cards at all is not a stricter gate — it is a platform
 * where nothing can be listed, and the failure looks like a bug in publishing
 * rather than a missing card.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findGateSubject: vi.fn(),
    effectiveEntry: vi.fn(),
    findLiveApprovalForListing: vi.fn(),
    findListingOwner: vi.fn(),
    createApproval: vi.fn(),
    findApproval: vi.fn(),
    decideApproval: vi.fn(),
    findCard: vi.fn(),
    setStatus: vi.fn(),
    activeCardsOverlapping: vi.fn(),
    // Lot E (Q97): approving now measures the card's impact; nothing here is affected.
    activeListingsPricedBy: vi.fn(async () => []),
  },
}));

vi.mock('../prisma-rate-cards.repository', () => ({ prismaRateCardsRepository: repository }));

const { findAgentProfile, holdsLiveGrant } = vi.hoisted(() => ({ findAgentProfile: vi.fn(), holdsLiveGrant: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentProfile, findWorkingAgentProfile: findAgentProfile }));
vi.mock('../../access-grants', () => ({ holdsLiveGrant }));

import { approveCard, assertMayAskGate, assertPublishable, checkGate, floorFor, gateView, quoteFromCard } from '../rate-cards.service';

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  status: 'DRAFT',
  mediaTypeId: 'mt_1',
  cityId: 'city_1',
  city: 'Bengaluru',
  rateGrade: 'A',
  ratePerDay: new Decimal('10000.00'),
  ...over,
});

/** A card at 10,000 a day with DR 10's 82% floor — 8,200. */
const covered = (rate = '10000.00', floorPct = '0.82') => ({
  card: {
    id: 'rc_1',
    name: 'Bengaluru Metro Premium',
    version: 4,
    floorPct: new Decimal(floorPct),
    roundingRupees: 100,
    cityId: 'city_1',
  },
  entry: { id: 'e1', mediaTypeId: 'mt_1', grade: 'A', ratePerDay: new Decimal(rate) },
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.activeListingsPricedBy.mockResolvedValue([]);
  repository.findGateSubject.mockResolvedValue(listing());
  repository.effectiveEntry.mockResolvedValue(covered());
  repository.findLiveApprovalForListing.mockResolvedValue(null);
  repository.findListingOwner.mockResolvedValue({ id: 'lst_1', publisher: { id: 'pub_1', userId: 'usr_pub', agentId: 'agt_home' } });
  findAgentProfile.mockResolvedValue(null);
  holdsLiveGrant.mockResolvedValue(false);
});

/**
 * E11 verify: who may ask the gate about a listing. The route lets every
 * publisher account through, so the service draws the line the listings edit
 * policy draws — ADX, the publisher, the agent who onboarded them, or an agent
 * under a live LISTINGS grant — and nobody else sees the floor or the case.
 */
describe('who may ask the gate', () => {
  const stranger = { userId: 'usr_other', isAdmin: false };

  it('lets ADX through without reading the listing', async () => {
    await expect(assertMayAskGate('lst_1', { userId: 'usr_ops', isAdmin: true })).resolves.toBeUndefined();
    expect(repository.findListingOwner).not.toHaveBeenCalled();
  });

  it("lets the listing's publisher through", async () => {
    await expect(assertMayAskGate('lst_1', { userId: 'usr_pub', isAdmin: false })).resolves.toBeUndefined();
  });

  it('refuses another publisher account with a 403', async () => {
    await expect(assertMayAskGate('lst_1', stranger)).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('lets the agent who onboarded the publisher through, and an agent under a live grant for this listing', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_home' });
    await expect(assertMayAskGate('lst_1', { userId: 'usr_agent', isAdmin: false })).resolves.toBeUndefined();

    findAgentProfile.mockResolvedValue({ id: 'agt_visiting' });
    holdsLiveGrant.mockResolvedValue(true);
    await expect(assertMayAskGate('lst_1', { userId: 'usr_agent2', isAdmin: false })).resolves.toBeUndefined();
    expect(holdsLiveGrant).toHaveBeenCalledWith('agt_visiting', 'pub_1', 'LISTINGS', 'lst_1');
  });

  it('refuses an agent with neither the relationship nor a grant', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_visiting' });
    holdsLiveGrant.mockResolvedValue(false);
    await expect(assertMayAskGate('lst_1', { userId: 'usr_agent2', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('is 404 for a listing that does not exist, and 403 for one nobody owns yet', async () => {
    repository.findListingOwner.mockResolvedValue(null);
    await expect(assertMayAskGate('lst_9', stranger)).rejects.toMatchObject({ statusCode: 404 });
    repository.findListingOwner.mockResolvedValue({ id: 'lst_1', publisher: null });
    await expect(assertMayAskGate('lst_1', { userId: 'usr_pub', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('a listing no card prices', () => {
  /**
   * The case that matters most, because it is every listing until ops build a
   * card. Refusing here would punish the publisher for an ADX omission.
   */
  it('publishes, rather than being blocked by a card that does not exist', async () => {
    repository.effectiveEntry.mockResolvedValue(null);
    await expect(checkGate('lst_1')).resolves.toEqual({ state: 'NOT_COVERED' });
    await expect(assertPublishable('lst_1')).resolves.toBeUndefined();
  });

  it('publishes when the card prices the media type but not at this grade', async () => {
    repository.effectiveEntry.mockResolvedValue({
      ...covered(),
      entry: { ...covered().entry, ratePerDay: null },
    });
    await expect(assertPublishable('lst_1')).resolves.toBeUndefined();
  });

  it('publishes an unpriced listing rather than reporting a card problem', async () => {
    repository.findGateSubject.mockResolvedValue(listing({ ratePerDay: null }));
    await expect(checkGate('lst_1')).resolves.toEqual({ state: 'NOT_COVERED' });
  });
});

/**
 * Lot U: the floor for a kind of spot before a listing exists — what the
 * listing importer warns against per row. The same card lookup as the gate,
 * at the default grade, and null wherever the gate would say NOT_COVERED.
 */
describe('the floor for a kind of spot (Lot U)', () => {
  it('answers the card in force and its floor at the default grade, or null where no card reaches', async () => {
    await expect(floorFor('mt_1', 'city_1')).resolves.toEqual({ cardId: 'rc_1', cardRate: '10000.00', floor: '8200.00' });
    expect(repository.effectiveEntry).toHaveBeenCalledWith('mt_1', 'B', 'city_1', expect.any(Date));
    repository.effectiveEntry.mockResolvedValue(null);
    await expect(floorFor('mt_1', null)).resolves.toBeNull();
    repository.effectiveEntry.mockResolvedValue({ ...covered(), entry: { ...covered().entry, ratePerDay: null } });
    await expect(floorFor('mt_1', null)).resolves.toBeNull();
  });
});

describe('a listing a card does price', () => {
  it('passes at the card rate', async () => {
    await expect(checkGate('lst_1')).resolves.toMatchObject({ state: 'OK', floor: '8200.00' });
    await expect(assertPublishable('lst_1')).resolves.toBeUndefined();
  });

  /** The floor is inclusive: exactly 82% is at the floor, not under it. */
  it('passes exactly at the floor', async () => {
    repository.findGateSubject.mockResolvedValue(listing({ ratePerDay: new Decimal('8200.00') }));
    await expect(checkGate('lst_1')).resolves.toMatchObject({ state: 'OK' });
  });

  it('refuses a paisa under the floor', async () => {
    repository.findGateSubject.mockResolvedValue(listing({ ratePerDay: new Decimal('8199.99') }));
    await expect(checkGate('lst_1')).resolves.toMatchObject({
      state: 'BELOW_FLOOR',
      floor: '8200.00',
      rate: '8199.99',
    });
    await expect(assertPublishable('lst_1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'BELOW_RATE_CARD_FLOOR',
    });
  });

  it('says which floor it means, so the number is arguable', async () => {
    repository.findGateSubject.mockResolvedValue(listing({ ratePerDay: new Decimal('5000') }));
    await expect(assertPublishable('lst_1')).rejects.toThrow(/8200\.00 a day/);
  });
});

describe('a price somebody has decided about', () => {
  const below = () =>
    repository.findGateSubject.mockResolvedValue(listing({ ratePerDay: new Decimal('5000') }));

  it('lets an approved price through despite the floor', async () => {
    below();
    repository.findLiveApprovalForListing.mockResolvedValue({ id: 'pa_1', status: 'APPROVED' });
    await expect(checkGate('lst_1')).resolves.toMatchObject({
      state: 'APPROVED_BELOW_FLOOR',
      approvalId: 'pa_1',
      // E11-1: the numbers ride along, so a phone can still print the floor.
      floor: '8200.00',
      rate: '5000.00',
    });
    await expect(assertPublishable('lst_1')).resolves.toBeUndefined();
  });

  /** Asked for is not the same as granted. */
  it('still holds a price that is only awaiting a decision', async () => {
    below();
    repository.findLiveApprovalForListing.mockResolvedValue({ id: 'pa_2', status: 'PENDING' });
    await expect(assertPublishable('lst_1')).rejects.toMatchObject({
      code: 'BELOW_RATE_CARD_FLOOR',
    });
  });

  it('does not treat a rejected request as a decision that lets it through', async () => {
    below();
    // A rejected request is not "live", so the repository does not return it and
    // the listing falls back to plain BELOW_FLOOR — which is the honest state.
    repository.findLiveApprovalForListing.mockResolvedValue(null);
    await expect(checkGate('lst_1')).resolves.toMatchObject({ state: 'BELOW_FLOOR' });
  });
});

/**
 * E11-1: the gate route's answer. The verdict stays what it was; beside it
 * the badge, the floor and the shortfall a phone prints, and the case standing
 * on the listing — whichever side raised it.
 */
describe('the gate view', () => {
  const below = () =>
    repository.findGateSubject.mockResolvedValue(listing({ ratePerDay: new Decimal('5000') }));
  const pendingCase = (over: Record<string, unknown> = {}) => ({
    id: 'pa_7',
    listingId: 'lst_1',
    status: 'PENDING',
    source: 'CARD_REVISION',
    graceUntil: new Date('2026-09-27T00:00:00Z'),
    heldByRunningOrder: false,
    decisionNote: null,
    ...over,
  });

  it('answers the floor and the shortfall under the floor, and no case when none stands', async () => {
    below();
    const view = await gateView('lst_1');
    expect(view).toMatchObject({
      state: 'BELOW_FLOOR',
      belowFloor: true,
      floorRatePerDay: '8200.00',
      shortfall: '3200.00',
      case: null,
    });
  });

  it('keeps the floor and the shortfall while a decision is awaited, and names the case', async () => {
    below();
    repository.findLiveApprovalForListing.mockResolvedValue(pendingCase());
    const view = await gateView('lst_1');
    expect(view).toMatchObject({
      state: 'AWAITING_APPROVAL',
      approvalId: 'pa_7',
      belowFloor: true,
      floorRatePerDay: '8200.00',
      shortfall: '3200.00',
      case: {
        id: 'pa_7',
        status: 'PENDING',
        source: 'CARD_REVISION',
        graceUntil: new Date('2026-09-27T00:00:00Z'),
        heldByRunningOrder: false,
      },
    });
  });

  it('reads the hold from the column, and from the legacy note prefix for one release', async () => {
    below();
    repository.findLiveApprovalForListing.mockResolvedValue(pendingCase({ heldByRunningOrder: true }));
    expect((await gateView('lst_1')).case).toMatchObject({ heldByRunningOrder: true });
    repository.findLiveApprovalForListing.mockResolvedValue(
      pendingCase({ heldByRunningOrder: false, decisionNote: 'HELD_BY_RUNNING_ORDER: order ord_1 still running' }),
    );
    expect((await gateView('lst_1')).case).toMatchObject({ heldByRunningOrder: true });
  });

  it('carries an approved case as the case, with the numbers it was approved against', async () => {
    below();
    repository.findLiveApprovalForListing.mockResolvedValue(
      pendingCase({ id: 'pa_8', status: 'APPROVED', source: 'PUBLISH_REQUEST', graceUntil: null }),
    );
    expect(await gateView('lst_1')).toMatchObject({
      state: 'APPROVED_BELOW_FLOOR',
      belowFloor: true,
      floorRatePerDay: '8200.00',
      shortfall: '3200.00',
      case: { id: 'pa_8', status: 'APPROVED', source: 'PUBLISH_REQUEST', graceUntil: null, heldByRunningOrder: false },
    });
  });

  it('at or above the floor: the floor is known, there is no shortfall, and a case still standing is still named', async () => {
    // A CARD_REVISION case whose publisher already raised the rate: the
    // listing is fine, ops have not closed the case yet — the phone should
    // still be able to say so.
    repository.findLiveApprovalForListing.mockResolvedValue(pendingCase());
    const view = await gateView('lst_1');
    expect(view).toMatchObject({
      state: 'OK',
      belowFloor: false,
      floorRatePerDay: '8200.00',
      shortfall: null,
      case: { id: 'pa_7', status: 'PENDING', source: 'CARD_REVISION' },
    });
  });

  it('answers nulls where no card reaches', async () => {
    repository.effectiveEntry.mockResolvedValue(null);
    expect(await gateView('lst_1')).toEqual({
      state: 'NOT_COVERED',
      belowFloor: false,
      floorRatePerDay: null,
      shortfall: null,
      case: null,
    });
  });
});

describe('approving a card', () => {
  /**
   * Two ACTIVE cards over one city is a state the lookup cannot resolve
   * honestly, and leaving the old one active until somebody remembers is
   * exactly how it happens.
   */
  it('supersedes what it replaces in the same breath', async () => {
    repository.findCard.mockResolvedValue({
      id: 'rc_2',
      status: 'PENDING_APPROVAL',
      cityId: 'city_1',
    });
    repository.activeCardsOverlapping.mockResolvedValue([{ id: 'rc_1' }, { id: 'rc_2' }]);
    repository.setStatus.mockResolvedValue({ id: 'rc_2', status: 'ACTIVE' });

    await approveCard('rc_2', 'usr_admin');

    expect(repository.setStatus).toHaveBeenCalledWith('rc_1', 'SUPERSEDED');
    // Not itself, even though it came back in the overlap query.
    expect(repository.setStatus).not.toHaveBeenCalledWith('rc_2', 'SUPERSEDED');
    expect(repository.setStatus).toHaveBeenCalledWith('rc_2', 'ACTIVE', {
      approvedById: 'usr_admin',
    });
  });

  it('refuses to approve a card nobody submitted', async () => {
    repository.findCard.mockResolvedValue({ id: 'rc_3', status: 'DRAFT', cityId: null });
    await expect(approveCard('rc_3', 'usr_admin')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the simulator trace', () => {
  it('starts from the card and names it', async () => {
    const quote = await quoteFromCard({ mediaTypeId: 'mt_1', grade: 'A' });
    expect(quote.base).toBe('10000.00');
    expect(quote.steps[0]).toMatchObject({
      step: 'Card rate',
      rule: 'Bengaluru Metro Premium v4 · grade A',
    });
  });

  /** Rupee adjustments before multipliers, so a multiplier sees the whole
   *  adjusted figure — the same order the comparables engine composes them in. */
  it('adds before it multiplies, and rounds last', async () => {
    const quote = await quoteFromCard({
      mediaTypeId: 'mt_1',
      grade: 'A',
      factors: [
        { name: 'Back-lit', kind: 'MULTIPLIER', value: '1.15' },
        { name: 'Corner site', kind: 'BASE_ADJUST', value: '500' },
      ],
    });
    // (10000 + 500) x 1.15 = 12075. Multiplying first would give
    // 10000 x 1.15 + 500 = 12000 — a different number, which is the point.
    expect(quote.steps.find((step) => step.step === 'Multiplier')?.running).toBe('12075.00');
    // Then the card's own rounding takes it to the nearest hundred.
    expect(quote.ratePerDay).toBe('12100.00');
    expect(quote.steps.map((step) => step.step)).toEqual([
      'Card rate',
      'Adjustment',
      'Multiplier',
      'Rounding',
    ]);
  });

  it('rounds to the card own rounding and shows it as a step', async () => {
    const quote = await quoteFromCard({
      mediaTypeId: 'mt_1',
      grade: 'A',
      factors: [{ name: 'Odd multiplier', kind: 'MULTIPLIER', value: '1.031' }],
    });
    // 10310 is already a multiple of 100, so nudge it off one.
    expect(quote.ratePerDay).toBe('10300.00');
    expect(quote.steps[quote.steps.length - 1]).toMatchObject({ step: 'Rounding', rule: 'Nearest 100' });
  });

  it('refuses to quote where no approved card reaches', async () => {
    repository.effectiveEntry.mockResolvedValue(null);
    await expect(quoteFromCard({ mediaTypeId: 'mt_9' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
