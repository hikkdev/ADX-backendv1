import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Order fraud screening (the owner, 2 Oct 2026) — the service over its reads.
 *
 * Pinned: scoring gathers both parties' signals (each side stamped) and the
 * order's own; the score, band and signals are written on the order; watch
 * mode flags and never holds; automatic holds hold through `orders` with no
 * person behind them, audited; the desk (holders of the fraud read
 * permission) is told in-app and no party ever is; screening off stops the
 * automatic triggers, not the desk's Rescore; a finished order is not
 * re-screened; a failure never reaches the order flow. Then the desk's acts:
 * a Clear remembers the firing signals; Cancel as fraud refuses a live order,
 * cancels through the ordinary cancel with a neutral reason and raises the
 * refund the way a suspension does; cancel-impact is the cancel's own dry
 * run; a fraud case is attached or opened on the advertiser. And the nightly
 * re-screen pages the open orders, evaluates each party once, and tells the
 * desk once.
 */

const SETTINGS = {
  enabled: true,
  reviewThreshold: 0.5,
  holdThreshold: 0.8,
  autoHold: false,
  newAccountDays: 7,
  bigOrderAmount: 100_000,
  velocityCount: 5,
  velocityMinutes: 60,
};

const h = vi.hoisted(() => ({
  settings: { current: {} as Record<string, unknown> },
  orders: {
    getOrderRiskState: vi.fn(),
    holdOrder: vi.fn(),
    releaseOrderHold: vi.fn(),
    recordOrderRisk: vi.fn(),
    cancelOrder: vi.fn(),
    listRiskReview: vi.fn(),
    openOrderIdsForScreening: vi.fn(),
  },
  access: { permissionsFor: vi.fn() },
  advertisers: { getAdvertiserForUser: vi.fn(), requestRefund: vi.fn() },
  campaigns: { cancelSpotsForOrders: vi.fn() },
  notifications: { createNotification: vi.fn() },
  users: { listAdminUserIds: vi.fn(), systemUserId: vi.fn() },
  cases: { findSummaryById: vi.fn(), findOpenForSubject: vi.fn(), addNote: vi.fn() },
  partyIndex: { resolveSubject: vi.fn() },
  fraudService: { openCaseRecord: vi.fn() },
  evaluate: vi.fn(),
  index: {
    advertiserForLogin: vi.fn(),
    loginCreatedAt: vi.fn(),
    publisherOfListing: vi.fn(),
    countOrdersPlaced: vi.fn(),
    overlappingOrders: vi.fn(),
    paymentHistory: vi.fn(),
    priorConfirmedFraud: vi.fn(),
    accruedForOrder: vi.fn(),
    agentsOnOrder: vi.fn(),
  },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ fraud: { orderScreening: h.settings.current } })) }));
vi.mock('../../access-control', () => h.access);
vi.mock('../../advertisers', () => h.advertisers);
vi.mock('../../campaigns', () => h.campaigns);
vi.mock('../../notifications', () => h.notifications);
vi.mock('../../users', () => h.users);
vi.mock('../../orders', () => ({ ...h.orders, isClosedOrder: (status: string) => status === 'COMPLETED' || status === 'CANCELLED' }));
vi.mock('../prisma-fraud.repository', () => ({ prismaFraudRepository: h.cases }));
vi.mock('../prisma-fraud-signals.repository', () => ({ prismaFraudSignalsIndex: h.partyIndex }));
vi.mock('../fraud.service', () => h.fraudService);
vi.mock('../signals', async (importOriginal) => ({ ...(await importOriginal<typeof import('../signals')>()), evaluateSignals: h.evaluate }));
vi.mock('../order-screening/prisma-order-screening.repository', () => ({ prismaOrderScreeningIndex: h.index }));
vi.mock('../../../shared/audit', () => h.audit);

import {
  cancelImpact,
  clearReview,
  confirmFraud,
  holdForReview,
  openOrderFraudCase,
  PARTY_CANCEL_REASON,
  releaseFromReview,
  runOrderRescreen,
  scoreOrder,
  screenOrder,
  screenOrderInBackground,
} from '../order-screening/order-screening.service';

const NOW = new Date('2026-10-02T12:00:00Z');
const ADMIN = { sub: 'usr_admin', roles: ['ADMIN'] };

const state = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  displayId: 'BKG-0210-2601',
  status: 'PENDING_PUBLISHER',
  advertiserId: 'usr_adv',
  listingId: 'lst_1',
  agentId: null,
  budget: 150_000,
  startDate: new Date('2026-10-10T00:00:00Z'),
  endDate: new Date('2026-10-20T00:00:00Z'),
  createdAt: new Date('2026-10-02T11:00:00Z'),
  riskScore: null,
  riskSignals: null,
  riskBand: null,
  riskScoredAt: null,
  riskReviewStatus: null,
  riskReviewedById: null,
  riskReviewedAt: null,
  riskReviewNote: null,
  riskClearedSignalKeys: [] as string[],
  heldAt: null as Date | null,
  heldById: null,
  holdReason: null,
  fraudCaseId: null as string | null,
  campaignSpot: { campaignId: 'cmp_1' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.settings.current = { ...SETTINGS };
  h.orders.getOrderRiskState.mockResolvedValue(state());
  h.orders.recordOrderRisk.mockImplementation(async (_id: string, patch: Record<string, unknown>) => state(patch));
  h.orders.holdOrder.mockImplementation(async (_id: string, hold: { byUserId: string | null; reason: string }) => state({ heldAt: NOW, heldById: hold.byUserId, holdReason: hold.reason }));
  h.orders.releaseOrderHold.mockResolvedValue(state());
  h.orders.cancelOrder.mockResolvedValue({ id: 'ord_1', status: 'CANCELLED' });
  h.access.permissionsFor.mockImplementation(async (userId: string) => (userId === 'usr_desk' ? ['kyc.view'] : ['marketplace.view']));
  h.users.listAdminUserIds.mockResolvedValue(['usr_desk', 'usr_other']);
  h.users.systemUserId.mockResolvedValue('usr_system');
  h.notifications.createNotification.mockResolvedValue({ id: 'ntf_1' });
  h.audit.logActivity.mockResolvedValue(undefined);
  // An old account, a modest order, nothing linked, no party signal firing.
  h.index.advertiserForLogin.mockResolvedValue({ id: 'adv_1', userId: 'usr_adv', agentId: null, onboardedByAgentUserId: null, createdAt: new Date('2025-01-01'), userCreatedAt: new Date('2025-01-01') });
  h.index.publisherOfListing.mockResolvedValue({ id: 'pub_1', userId: 'usr_pub', agentId: null, onboardedByAgentUserId: null, createdAt: new Date('2025-01-01') });
  h.index.loginCreatedAt.mockResolvedValue(null);
  h.index.countOrdersPlaced.mockResolvedValue(1);
  h.index.overlappingOrders.mockResolvedValue([]);
  h.index.paymentHistory.mockResolvedValue({ failedAttempts: 0, refunds: 0 });
  h.index.priorConfirmedFraud.mockResolvedValue({ advertiserCases: 0, publisherCases: 0, advertiserOrders: 0, publisherOrders: 0 });
  h.index.accruedForOrder.mockResolvedValue('0.00');
  h.index.agentsOnOrder.mockResolvedValue(0);
  h.partyIndex.resolveSubject.mockImplementation(async ({ type, id }: { type: string; id: string }) => ({ type, id, userId: `usr_${id}`, name: id, mobile: null, pan: null, kycStatus: null, agentId: null, listingId: null }));
  h.evaluate.mockResolvedValue({ signals: [], score: 0 });
  h.campaigns.cancelSpotsForOrders.mockResolvedValue([]);
});

/** The advertiser and the publisher share a PAN: LINKED_PARTIES (0.5) plus the party's own SHARED_PAN (0.35) = 0.85. */
function linkedByPan() {
  h.evaluate.mockImplementation(async (subject: { type: string }) =>
    subject.type === 'ADVERTISER'
      ? { score: 0.35, signals: [{ key: 'SHARED_PAN', weight: 0.35, value: 1, detail: 'Same PAN as Kumar Hoardings', links: [{ type: 'PUBLISHER', id: 'pub_1', name: 'Kumar Hoardings' }] }] }
      : { score: 0, signals: [] },
  );
}

describe('scoreOrder', () => {
  it('scores both parties and the order, every signal with its side', async () => {
    linkedByPan();
    const scored = await scoreOrder('ord_1', NOW);
    expect(scored.score).toBe(0.85);
    expect(scored.band).toBe('HOLD');
    expect(scored.signals.filter((s) => s.side === 'ADVERTISER').map((s) => s.key)).toEqual(['SHARED_PAN']);
    expect(scored.signals.filter((s) => s.side === 'ORDER').map((s) => s.key)).toEqual(['NEW_ACCOUNT_BIG_ORDER', 'ORDER_VELOCITY', 'DUPLICATE_ORDER', 'PAYMENT_TROUBLE', 'LINKED_PARTIES', 'PRIOR_CONFIRMED_FRAUD']);
    expect(scored.signals.find((s) => s.key === 'LINKED_PARTIES')).toMatchObject({ value: 1, detail: 'The advertiser and the publisher share: the same PAN.' });
    // The party signals were evaluated on the advertiser profile and the listing's publisher.
    expect(h.partyIndex.resolveSubject).toHaveBeenCalledWith({ type: 'ADVERTISER', id: 'adv_1' });
    expect(h.partyIndex.resolveSubject).toHaveBeenCalledWith({ type: 'PUBLISHER', id: 'pub_1' });
    // The velocity window ends at placement; the payments are read on the order's campaign.
    expect(h.index.countOrdersPlaced).toHaveBeenCalledWith('usr_adv', new Date('2026-10-02T10:00:00Z'), new Date('2026-10-02T11:00:00Z'));
    expect(h.index.paymentHistory).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: 'adv_1', campaignId: 'cmp_1' }));
  });

  it('reads the account age off the earlier of the profile and the login', async () => {
    h.index.advertiserForLogin.mockResolvedValue({ id: 'adv_1', userId: 'usr_adv', agentId: null, onboardedByAgentUserId: null, createdAt: new Date('2026-10-01T00:00:00Z'), userCreatedAt: new Date('2026-10-01T09:00:00Z') });
    const scored = await scoreOrder('ord_1', NOW);
    expect(scored.signals.find((s) => s.key === 'NEW_ACCOUNT_BIG_ORDER')).toMatchObject({ value: 1 });
  });

  it('404s on an order that does not exist', async () => {
    h.orders.getOrderRiskState.mockResolvedValue(null);
    await expect(scoreOrder('nope', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('screenOrder', () => {
  it('writes the score, the band and the signals, and in watch mode flags without holding', async () => {
    linkedByPan();
    const result = await screenOrder('ord_1', { trigger: 'PLACED', now: NOW });
    expect(h.orders.recordOrderRisk).toHaveBeenCalledWith('ord_1', expect.objectContaining({ riskScore: '0.850', riskBand: 'HOLD', riskScoredAt: NOW, riskReviewStatus: 'FLAGGED' }));
    const written = h.orders.recordOrderRisk.mock.calls[0]![1] as { riskSignals: { side: string }[] };
    expect(written.riskSignals.some((s) => s.side === 'ORDER')).toBe(true);
    expect(h.orders.holdOrder).not.toHaveBeenCalled();
    expect(result).toMatchObject({ held: false, outcome: { newlyFlagged: true, hold: false } });
  });

  it('tells the desk — the holders of the fraud read permission — in-app, and nobody else', async () => {
    linkedByPan();
    await screenOrder('ord_1', { trigger: 'PLACED', now: NOW });
    expect(h.notifications.createNotification).toHaveBeenCalledTimes(1);
    const sent = h.notifications.createNotification.mock.calls[0]![0] as { userId: string; title: string; type: string };
    expect(sent).toMatchObject({ userId: 'usr_desk', type: 'SYSTEM', title: 'Order BKG-0210-2601 flagged for review' });
    expect(h.notifications.createNotification.mock.calls.map((call) => (call[0] as { userId: string }).userId)).not.toContain('usr_adv');
  });

  it('with automatic holds on, holds at the hold threshold — no person behind it — and audits it', async () => {
    linkedByPan();
    h.settings.current = { ...SETTINGS, autoHold: true };
    const result = await screenOrder('ord_1', { trigger: 'PAYMENT', now: NOW });
    expect(h.orders.holdOrder).toHaveBeenCalledWith('ord_1', expect.objectContaining({ byUserId: null, reason: expect.stringContaining('0.850') }));
    expect(result?.held).toBe(true);
    expect(h.audit.logActivity).toHaveBeenCalledWith('usr_system', 'ORDER_HELD', expect.objectContaining({ targetType: 'Order', targetId: 'ord_1', metadata: expect.objectContaining({ automatic: true }) }));
  });

  it('with automatic holds on, does not hold below the hold threshold', async () => {
    h.settings.current = { ...SETTINGS, autoHold: true };
    h.evaluate.mockImplementation(async (subject: { type: string }) =>
      subject.type === 'ADVERTISER' ? { score: 0.6, signals: [{ key: 'SELF_DEALING', weight: 0.4, value: 1, detail: 'x' }, { key: 'BANK_NAME_MISMATCH', weight: 0.2, value: 1, detail: 'y' }] } : { score: 0, signals: [] },
    );
    const result = await screenOrder('ord_1', { trigger: 'PLACED', now: NOW });
    expect(result?.score.score).toBe(0.6);
    expect(h.orders.holdOrder).not.toHaveBeenCalled();
    expect(h.orders.recordOrderRisk).toHaveBeenCalledWith('ord_1', expect.objectContaining({ riskBand: 'REVIEW', riskReviewStatus: 'FLAGGED' }));
  });

  it('keeps a cleared order cleared on the same signals', async () => {
    linkedByPan();
    h.orders.getOrderRiskState.mockResolvedValue(state({ riskReviewStatus: 'CLEARED', riskClearedSignalKeys: ['ADVERTISER:SHARED_PAN', 'ORDER:LINKED_PARTIES', 'ORDER:NEW_ACCOUNT_BIG_ORDER'] }));
    h.settings.current = { ...SETTINGS, autoHold: true };
    const result = await screenOrder('ord_1', { trigger: 'NIGHTLY', now: NOW });
    expect(h.orders.recordOrderRisk).toHaveBeenCalledWith('ord_1', expect.objectContaining({ riskReviewStatus: 'CLEARED' }));
    expect(result?.outcome.newlyFlagged).toBe(false);
    expect(h.orders.holdOrder).not.toHaveBeenCalled();
    expect(h.notifications.createNotification).not.toHaveBeenCalled();
  });

  it('with screening off, the automatic triggers do nothing and the desk’s Rescore still scores', async () => {
    h.settings.current = { ...SETTINGS, enabled: false };
    expect(await screenOrder('ord_1', { trigger: 'PLACED', now: NOW })).toBeNull();
    expect(h.orders.recordOrderRisk).not.toHaveBeenCalled();
    expect(await screenOrder('ord_1', { trigger: 'MANUAL', now: NOW })).not.toBeNull();
    expect(h.orders.recordOrderRisk).toHaveBeenCalledTimes(1);
  });

  it('skips a finished order on the automatic triggers', async () => {
    h.orders.getOrderRiskState.mockResolvedValue(state({ status: 'COMPLETED' }));
    expect(await screenOrder('ord_1', { trigger: 'NIGHTLY', now: NOW })).toBeNull();
    expect(h.orders.recordOrderRisk).not.toHaveBeenCalled();
  });

  it('in the background, never throws into the order flow', async () => {
    h.orders.getOrderRiskState.mockRejectedValue(new Error('database away'));
    await expect(screenOrderInBackground('ord_1', 'PLACED')).resolves.toBeUndefined();
  });
});

describe('the desk’s acts', () => {
  it('hold and release go through orders, by the person', async () => {
    await holdForReview('ord_1', ADMIN, 'Same bank as the publisher', NOW);
    expect(h.orders.holdOrder).toHaveBeenCalledWith('ord_1', { byUserId: 'usr_admin', reason: 'Same bank as the publisher', at: NOW });
    h.orders.getOrderRiskState.mockResolvedValue(state({ heldAt: NOW }));
    await releaseFromReview('ord_1', ADMIN, 'Spoke to them', NOW);
    expect(h.orders.releaseOrderHold).toHaveBeenCalledWith('ord_1');
    expect(h.orders.recordOrderRisk).toHaveBeenCalledWith('ord_1', { riskReviewNote: 'Spoke to them', riskReviewedById: 'usr_admin', riskReviewedAt: NOW });
  });

  it('refuses a non-admin', async () => {
    await expect(holdForReview('ord_1', { sub: 'usr_adv', roles: ['ADVERTISER'] }, 'x', NOW)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('Clear releases a held order, marks it CLEARED and remembers the firing signals beside any cleared before', async () => {
    h.orders.getOrderRiskState.mockResolvedValue(
      state({
        heldAt: NOW,
        riskReviewStatus: 'FLAGGED',
        riskClearedSignalKeys: ['ORDER:ORDER_VELOCITY'],
        riskSignals: [
          { key: 'SHARED_PAN', side: 'ADVERTISER', weight: 0.35, value: 1, detail: '' },
          { key: 'DUPLICATE_ORDER', side: 'ORDER', weight: 0.3, value: 0, detail: '' },
          { key: 'LINKED_PARTIES', side: 'ORDER', weight: 0.5, value: 1, detail: '' },
        ],
      }),
    );
    await clearReview('ord_1', ADMIN, 'Family business, known to us', NOW);
    expect(h.orders.releaseOrderHold).toHaveBeenCalledWith('ord_1');
    expect(h.orders.recordOrderRisk).toHaveBeenCalledWith('ord_1', {
      riskReviewStatus: 'CLEARED',
      riskReviewedById: 'usr_admin',
      riskReviewedAt: NOW,
      riskReviewNote: 'Family business, known to us',
      riskClearedSignalKeys: ['ORDER:ORDER_VELOCITY', 'ADVERTISER:SHARED_PAN', 'ORDER:LINKED_PARTIES'],
    });
  });

  it('Clear refuses an order confirmed as fraud', async () => {
    h.orders.getOrderRiskState.mockResolvedValue(state({ riskReviewStatus: 'CONFIRMED_FRAUD' }));
    await expect(clearReview('ord_1', ADMIN, undefined, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('Cancel as fraud: the verdict, the ordinary cancel with a neutral reason, the campaign side and the refund request', async () => {
    h.orders.getOrderRiskState.mockResolvedValue(state({ heldAt: NOW, status: 'PENDING_AGENT' }));
    h.campaigns.cancelSpotsForOrders.mockResolvedValue([{ campaignId: 'cmp_1', reference: 'CMP-1', advertiserId: 'adv_1', amount: '12000.00', spotIds: ['spt_1'], refundNeeded: true }]);
    h.advertisers.requestRefund.mockResolvedValue({ id: 'rfr_1' });
    const result = await confirmFraud('ord_1', ADMIN, 'Stolen card, confirmed with the bank', NOW);
    expect(h.orders.recordOrderRisk).toHaveBeenCalledWith('ord_1', { riskReviewStatus: 'CONFIRMED_FRAUD', riskReviewedById: 'usr_admin', riskReviewedAt: NOW, riskReviewNote: 'Stolen card, confirmed with the bank' });
    expect(h.orders.cancelOrder).toHaveBeenCalledWith('ord_1', PARTY_CANCEL_REASON, 'usr_admin');
    expect(PARTY_CANCEL_REASON).not.toMatch(/fraud/i);
    expect(h.orders.releaseOrderHold).toHaveBeenCalledWith('ord_1');
    expect(h.campaigns.cancelSpotsForOrders).toHaveBeenCalledWith(['ord_1'], NOW);
    expect(h.advertisers.requestRefund).toHaveBeenCalledWith('adv_1', { amount: '12000.00', reason: 'OTHER', note: 'Order BKG-0210-2601: Cancelled after an ADX review' }, 'usr_admin');
    const refundNote = (h.advertisers.requestRefund.mock.calls[0]![1] as { note: string }).note;
    expect(refundNote).not.toMatch(/fraud/i);
    expect(result.refunds).toEqual([{ campaignId: 'cmp_1', amount: '12000.00', requested: true }]);
  });

  it.each(['PENDING_OTP', 'PENDING_APPROVAL', 'COMPLETED'])('Cancel as fraud refuses an order whose advertisement is up (%s) with 409 ORDER_LIVE', async (status) => {
    h.orders.getOrderRiskState.mockResolvedValue(state({ status }));
    await expect(confirmFraud('ord_1', ADMIN, 'reason', NOW)).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_LIVE', message: expect.stringContaining('dispute') });
    expect(h.orders.cancelOrder).not.toHaveBeenCalled();
    expect(h.orders.recordOrderRisk).not.toHaveBeenCalled();
  });

  it('Cancel as fraud refuses a cancelled order', async () => {
    h.orders.getOrderRiskState.mockResolvedValue(state({ status: 'CANCELLED' }));
    await expect(confirmFraud('ord_1', ADMIN, 'reason', NOW)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });

  it('cancel-impact is the cancel’s own computation as a dry run, read only', async () => {
    h.orders.getOrderRiskState.mockResolvedValue(state({ agentId: 'agt_1' }));
    h.campaigns.cancelSpotsForOrders.mockResolvedValue([{ campaignId: 'cmp_1', reference: 'CMP-1', advertiserId: 'adv_1', amount: '8000.00', spotIds: ['spt_1'], refundNeeded: true }]);
    h.index.accruedForOrder.mockResolvedValue('1500.00');
    h.index.agentsOnOrder.mockResolvedValue(2);
    const impact = await cancelImpact('ord_1', NOW);
    expect(h.campaigns.cancelSpotsForOrders).toHaveBeenCalledWith(['ord_1'], NOW, { dryRun: true });
    expect(impact).toMatchObject({
      cancellable: true,
      blockedReason: null,
      refund: { amount: '8000.00', to: 'ADVERTISER_WALLET' },
      publisherReversal: { amount: '0.00', accruedToDate: '1500.00' },
      agentsReleased: 2,
      campaign: { campaignId: 'cmp_1', reference: 'CMP-1', spotsCancelled: 1, refundNeeded: true },
      campaignEffects: [
        'Campaign CMP-1: this spot is cancelled; the rest of the campaign runs on.',
        'The unused days (8000.00) are raised as a refund request to the advertiser’s wallet.',
      ],
    });
    expect(h.orders.cancelOrder).not.toHaveBeenCalled();
    expect(h.advertisers.requestRefund).not.toHaveBeenCalled();
  });

  it('cancel-impact on a scheduled campaign: nothing to refund, the hold goes back with the campaign', async () => {
    h.campaigns.cancelSpotsForOrders.mockResolvedValue([{ campaignId: 'cmp_1', reference: 'CMP-1', advertiserId: 'adv_1', amount: '8000.00', spotIds: ['spt_1'], refundNeeded: false }]);
    const impact = await cancelImpact('ord_1', NOW);
    expect(impact.refund).toMatchObject({ amount: '0.00', to: 'NONE' });
    expect(impact.campaignEffects[1]).toBe('The campaign’s money is still only held; it is released with the campaign.');
  });

  it('cancel-impact says when the cancel would be refused', async () => {
    h.orders.getOrderRiskState.mockResolvedValue(state({ status: 'COMPLETED' }));
    const impact = await cancelImpact('ord_1', NOW);
    expect(impact).toMatchObject({ cancellable: false, blockedReason: expect.stringContaining('dispute'), agentsReleased: 0 });
  });

  it('a fraud case is attached to the advertiser’s open case, or opened on them, and named on the order', async () => {
    h.advertisers.getAdvertiserForUser.mockResolvedValue({ id: 'adv_1' });
    h.cases.findOpenForSubject.mockResolvedValue({ id: 'frd_open', displayId: 'FRD-1', status: 'INVESTIGATING' });
    const attached = await openOrderFraudCase('ord_1', ADMIN, NOW);
    expect(h.cases.addNote).toHaveBeenCalledWith(expect.objectContaining({ caseId: 'frd_open', byUserId: 'usr_admin', body: expect.stringContaining('BKG-0210-2601') }));
    expect(h.orders.recordOrderRisk).toHaveBeenCalledWith('ord_1', { fraudCaseId: 'frd_open' });
    expect(attached).toMatchObject({ opened: false, attached: true });

    vi.clearAllMocks();
    h.orders.getOrderRiskState.mockResolvedValue(state());
    h.orders.recordOrderRisk.mockImplementation(async (_id: string, patch: Record<string, unknown>) => state(patch));
    h.advertisers.getAdvertiserForUser.mockResolvedValue({ id: 'adv_1' });
    h.cases.findOpenForSubject.mockResolvedValue(null);
    h.fraudService.openCaseRecord.mockResolvedValue({ id: 'frd_new', displayId: 'FRD-2', status: 'OPEN', subjectType: 'ADVERTISER', subjectId: 'adv_1', kind: 'ORDER_FRAUD' });
    const opened = await openOrderFraudCase('ord_1', ADMIN, NOW);
    expect(h.fraudService.openCaseRecord).toHaveBeenCalledWith(expect.objectContaining({ subjectType: 'ADVERTISER', subjectId: 'adv_1', kind: 'ORDER_FRAUD', openedByUserId: 'usr_admin', summary: expect.stringContaining('ord_1') }), NOW);
    expect(opened).toMatchObject({ opened: true, attached: false, after: { fraudCaseId: 'frd_new' } });
  });

  it('a fraud case: an order already on an open case answers it; no advertiser profile is a 409', async () => {
    h.orders.getOrderRiskState.mockResolvedValue(state({ fraudCaseId: 'frd_open' }));
    h.cases.findSummaryById.mockResolvedValue({ id: 'frd_open', status: 'OPEN' });
    expect(await openOrderFraudCase('ord_1', ADMIN, NOW)).toMatchObject({ opened: false, attached: true });
    expect(h.fraudService.openCaseRecord).not.toHaveBeenCalled();

    h.orders.getOrderRiskState.mockResolvedValue(state());
    h.advertisers.getAdvertiserForUser.mockResolvedValue(null);
    await expect(openOrderFraudCase('ord_1', ADMIN, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the nightly re-screen', () => {
  it('pages the open orders, evaluates each party once, and tells the desk once for the batch', async () => {
    linkedByPan();
    h.orders.openOrderIdsForScreening.mockResolvedValueOnce(['ord_1', 'ord_2', 'ord_3']).mockResolvedValueOnce([]);
    h.orders.getOrderRiskState.mockImplementation(async (id: string) => (id === 'ord_3' ? Promise.reject(new Error('gone')) : state({ id, displayId: id })));
    const report = await runOrderRescreen(NOW);
    expect(report).toEqual({ scanned: 2, flagged: 2, held: 0, failed: 1, skipped: false });
    // Two orders on the same two parties: each party evaluated once.
    expect(h.evaluate).toHaveBeenCalledTimes(2);
    expect(h.notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(h.notifications.createNotification.mock.calls[0]![0]).toMatchObject({ userId: 'usr_desk', title: '2 orders flagged for review' });
  });

  it('does nothing while screening is off', async () => {
    h.settings.current = { ...SETTINGS, enabled: false };
    expect(await runOrderRescreen(NOW)).toEqual({ scanned: 0, flagged: 0, held: 0, failed: 0, skipped: true });
    expect(h.orders.openOrderIdsForScreening).not.toHaveBeenCalled();
  });
});
