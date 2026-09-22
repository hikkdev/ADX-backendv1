import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LH2 (the Lead Hunt, 22 Sep 2026) — the twelve stages.
 *
 * Pinned: the move rules (forward only; LOST from anywhere open; CONVERTED
 * only through /convert; ACTIVATED / RETAINED only the system's; the
 * recycle back to SCORED); the loss reasons (PRICE / TIMING recycle in 60
 * days, WRONG_CONTACT goes back to sourcing, OTHER needs a note); the
 * status the pill reads syncing with the stage; D14's attribution stamped
 * once; the retention watch reading the catch and the repeat off the
 * account and paying LEAD_ACTIVATED / LEAD_RETAINED once; the recycle
 * job; the next step per stage; the funnel query.
 */

const { repository, agents, payouts, pricing } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    update: vi.fn(),
    logActivity: vi.fn(),
    findAtStages: vi.fn(),
    dueForRecycle: vi.fn(),
    accountActivation: vi.fn(),
    accountRetention: vi.fn(),
    attributeAccountToAgent: vi.fn(async (): Promise<'PUBLISHER' | 'ADVERTISER' | null> => null),
    funnel: vi.fn(),
    findForScoring: vi.fn().mockResolvedValue(null),
  },
  agents: { findAgentTier: vi.fn(async () => 'SILVER'), findAgentProfile: vi.fn(), assertAgentAcceptsWork: vi.fn(), agentMeetsGrade: vi.fn(async () => true), getRoutingSettings: vi.fn(async () => ({ enforce: false })) },
  payouts: { recordIncentiveOnce: vi.fn(async (input: { event: string }) => ({ id: `inc_${input.event}`, amount: '500.00' })), rateFor: vi.fn() },
  pricing: { cityKeyFor: vi.fn(async () => ({ cityId: 'city_blr' })), withCityKey: vi.fn(async (x: unknown) => x), citySupport: vi.fn() },
}));

vi.mock('../prisma-leads.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prisma-leads.repository')>();
  return { prismaLeadsRepository: repository, distanceM: actual.distanceM };
});
vi.mock('../../agents', () => agents);
vi.mock('../../payouts', () => payouts);
vi.mock('../../pricing', () => pricing);
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ leads: { scoring: { weights: { fitMax: 30, intentMax: 35, recencyMin: -25, sourceMax: 15, agentFlag: 10 }, recency: { afterDays7: -5, afterDays21: -15, afterDays45: -25 }, thresholds: { hot: 70, warm: 40 }, agentFlagDays: 14, intent: {}, fit: { defaultCategory: 12, categoryBySide: { PUBLISHER: {}, ADVERTISER: {} }, importanceBonus: { KEY: 4, ENTERPRISE: 8 }, localityBonus: 6, localityRadiusM: 1000 } } } })) }));

import { funnel, moveStage, markEngaged, recycleDue, registerLeadRecyclePort, watchRetention, advanceStage } from '../stages.service';
import { nextStepOf, recycleAtFor, stageMove, stampAttribution, statusForStage, isOpenStage, isWonStage } from '../stages.rules';
import { funnelQuerySchema, moveStageSchema, markLostSchema } from '../leads.schema';

const now = new Date('2026-09-22T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const lead = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
  displayId: 'LED-0001',
  side: 'PUBLISHER',
  businessName: 'Suraj Kumar Prints',
  status: 'NEW',
  stage: 'SCORED',
  stageChangedAt: now,
  assignedAgentId: 'agt_1',
  convertedPublisherId: null,
  convertedAdvertiserId: null,
  activatedAt: null,
  lostReason: null,
  recycleAt: null,
  attribution: null,
  activity: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => patch);
  repository.findForScoring.mockResolvedValue(null);
});

describe('the move rules', () => {
  it('go forward only, except a loss from anywhere open and the recycle', () => {
    expect(stageMove('SCORED', 'CLAIMED', 'ADMIN').ok).toBe(true);
    expect(stageMove('CLAIMED', 'SCORED', 'ADMIN')).toEqual({ ok: false, reason: 'Stages move forward only' });
    expect(stageMove('SCORED', 'SCORED', 'ADMIN').ok).toBe(false);
    expect(stageMove('ENGAGED', 'LOST', 'AGENT').ok).toBe(true);
    expect(stageMove('ACTIVATED', 'LOST', 'ADMIN').ok).toBe(false);
    expect(stageMove('LOST', 'SCORED', 'SYSTEM').ok).toBe(true);
    expect(stageMove('LOST', 'SCORED', 'ADMIN').ok).toBe(true);
    expect(stageMove('LOST', 'CONTACTED', 'ADMIN').ok).toBe(false);
    expect(stageMove('LOST', 'SCORED', 'AGENT').ok).toBe(false);
  });

  it('keep the money-bearing stages the system’s own', () => {
    expect(stageMove('PROPOSED', 'CONVERTED', 'ADMIN')).toMatchObject({ ok: false, reason: expect.stringContaining('/convert') });
    expect(stageMove('PROPOSED', 'CONVERTED', 'SYSTEM').ok).toBe(true);
    expect(stageMove('ONBOARDING', 'ACTIVATED', 'ADMIN').ok).toBe(false);
    expect(stageMove('ONBOARDING', 'ACTIVATED', 'SYSTEM').ok).toBe(true);
    expect(stageMove('ACTIVATED', 'RETAINED', 'AGENT').ok).toBe(false);
    expect(stageMove('CONVERTED', 'ONBOARDING', 'ADMIN').ok).toBe(true);
    expect(stageMove('SCORED', 'ONBOARDING', 'ADMIN').ok).toBe(false);
  });

  it('sync the lifecycle status the pill reads', () => {
    expect(statusForStage('CONTACTED', 'NEW')).toBe('CONTACTED');
    expect(statusForStage('CONTACTED', 'VISIT_BOOKED')).toBeNull();
    expect(statusForStage('VISIT_BOOKED', 'CONTACTED')).toBe('VISIT_BOOKED');
    expect(statusForStage('ACTIVATED', 'CONVERTED')).toBe('CONVERTED');
    expect(statusForStage('LOST', 'CONTACTED')).toBe('LOST');
    expect(statusForStage('SCORED', 'LOST')).toBe('NEW');
    expect(isOpenStage('PROPOSED')).toBe(true);
    expect(isOpenStage('CONVERTED')).toBe(false);
    expect(isWonStage('RETAINED')).toBe(true);
    expect(isWonStage('LOST')).toBe(false);
  });

  it('recycle PRICE and TIMING in sixty days, nothing else, and stamp attribution once', () => {
    expect(recycleAtFor('PRICE', now)?.toISOString()).toBe(new Date(now.getTime() + 60 * DAY).toISOString());
    expect(recycleAtFor('TIMING', now)).not.toBeNull();
    expect(recycleAtFor('NOT_INTERESTED', now)).toBeNull();
    expect(recycleAtFor('COMPETITOR', now)).toBeNull();
    const first = stampAttribution(null, 'firstContact', 'CALL', now);
    expect(first).toEqual({ firstContact: { channel: 'CALL', at: now.toISOString() } });
    const again = stampAttribution(first, 'firstContact', 'WHATSAPP', new Date(now.getTime() + DAY));
    expect(again.firstContact?.channel).toBe('CALL');
    expect(stampAttribution(first, 'converted', 'LINK', now).converted?.channel).toBe('LINK');
  });

  it('name the next step per stage, and the loss with its return date', () => {
    expect(nextStepOf({ stage: 'SCORED', side: 'PUBLISHER' }).action).toBe('CLAIM');
    expect(nextStepOf({ stage: 'ENGAGED', side: 'ADVERTISER' }).label).toBe('Book a demo or a call');
    expect(nextStepOf({ stage: 'ONBOARDING', side: 'ADVERTISER' }).label).toBe('The catch: first campaign paid');
    expect(nextStepOf({ stage: 'RETAINED', side: 'PUBLISHER' }).action).toBe('NONE');
    expect(nextStepOf({ stage: 'LOST', side: 'PUBLISHER', lostReason: 'PRICE', recycleAt: '2026-11-21T09:00:00.000Z' }).label).toBe('Lost: Price · back in the pool 2026-11-21');
  });
});

describe('moving a lead', () => {
  it('writes the stage, the status, the STAGE_CHANGED row and the touch', async () => {
    repository.findById.mockResolvedValue(lead({ stage: 'CLAIMED', status: 'NEW' }));
    await moveStage('led_1', 'CONTACTED', 'ADMIN', { actorUserId: 'usr_admin', channel: 'CALL', note: 'called from the desk' });
    const written = repository.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(written).toMatchObject({ stage: 'CONTACTED', status: 'CONTACTED' });
    expect((written.attribution as { firstContact: { channel: string } }).firstContact.channel).toBe('CALL');
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'STAGE_CHANGED', note: 'CLAIMED → CONTACTED — called from the desk' }));
    // The touch restarted the recency clock.
    expect(repository.update.mock.calls.some((call) => 'lastTouchedAt' in (call[1] as object))).toBe(true);
  });

  it('refuses a backward move, a hand-set conversion, and a loss without a reason', async () => {
    repository.findById.mockResolvedValue(lead({ stage: 'ENGAGED' }));
    await expect(moveStage('led_1', 'CLAIMED', 'ADMIN', { actorUserId: 'u' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(moveStage('led_1', 'CONVERTED', 'ADMIN', { actorUserId: 'u' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(moveStage('led_1', 'LOST', 'AGENT', { actorUserId: 'u' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(moveStage('led_1', 'LOST', 'AGENT', { actorUserId: 'u', reason: 'OTHER' })).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('a PRICE loss carries its recycle date; a wrong contact goes back to sourcing, unassigned', async () => {
    repository.findById.mockResolvedValue(lead({ stage: 'PROPOSED', status: 'CONTACTED' }));
    await moveStage('led_1', 'LOST', 'AGENT', { actorUserId: 'usr_agent', reason: 'PRICE', lostNote: 'too dear', at: now });
    expect(repository.update.mock.calls[0]![1]).toMatchObject({ stage: 'LOST', status: 'LOST', lostReason: 'PRICE', lostNote: 'too dear', recycleAt: new Date(now.getTime() + 60 * DAY) });
    // A closed lead is not re-scored.
    expect(repository.update.mock.calls.some((call) => 'lastTouchedAt' in (call[1] as object))).toBe(false);

    vi.clearAllMocks();
    repository.findById.mockResolvedValue(lead({ stage: 'CONTACTED', status: 'CONTACTED', assignedAgentId: 'agt_1' }));
    await moveStage('led_1', 'LOST', 'ADMIN', { actorUserId: 'usr_admin', reason: 'WRONG_CONTACT', at: now });
    expect(repository.update.mock.calls[0]![1]).toMatchObject({ stage: 'SOURCED', status: 'NEW', assignedAgentId: null, lostReason: 'WRONG_CONTACT' });
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ note: expect.stringContaining('back to sourcing') }));
  });

  it('a side-effect advance never throws and never goes backward, but still stamps a new channel', async () => {
    repository.findById.mockResolvedValue(lead({ stage: 'ENGAGED', attribution: { firstContact: { channel: 'CALL', at: now.toISOString() } } }));
    await advanceStage('led_1', 'CONTACTED', { actorUserId: 'u', channel: 'WHATSAPP' });
    // Already past CONTACTED: no stage write, and the first-contact stamp stands.
    expect(repository.update).not.toHaveBeenCalled();
    await advanceStage('led_1', 'ENGAGED', { actorUserId: 'u', channel: 'WHATSAPP' });
    expect(repository.update).toHaveBeenCalledWith('led_1', { attribution: { firstContact: { channel: 'CALL', at: now.toISOString() }, engaged: { channel: 'WHATSAPP', at: expect.any(String) } } });
  });

  it('they replied: ENGAGED from any open stage, with the row and the stamp', async () => {
    repository.findById.mockResolvedValue(lead({ stage: 'CONTACTED', status: 'CONTACTED' }));
    await markEngaged('led_1', 'usr_agent', { note: 'Asked for a callback', channel: 'WHATSAPP' });
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ENGAGED', note: 'Asked for a callback' }));
    expect(repository.update.mock.calls.some((call) => (call[1] as { stage?: string }).stage === 'ENGAGED')).toBe(true);
  });
});

describe('the retention watch', () => {
  it('moves a converted lead to ONBOARDING, then to ACTIVATED on the first live listing and pays LEAD_ACTIVATED once', async () => {
    const converted = lead({ stage: 'CONVERTED', status: 'CONVERTED', convertedPublisherId: 'pub_1' });
    repository.findAtStages.mockResolvedValueOnce([converted]).mockResolvedValueOnce([]);
    repository.findById.mockResolvedValue(converted);
    repository.accountActivation.mockResolvedValue({ activatedAt: null, label: null });
    const first = await watchRetention(now);
    expect(first).toEqual({ checked: 1, activated: 0, retained: 0 });
    expect(repository.update.mock.calls.some((call) => (call[1] as { stage?: string }).stage === 'ONBOARDING')).toBe(true);
    expect(payouts.recordIncentiveOnce).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const onboarding = lead({ stage: 'ONBOARDING', status: 'CONVERTED', convertedPublisherId: 'pub_1' });
    repository.findAtStages.mockResolvedValueOnce([onboarding]).mockResolvedValueOnce([]);
    repository.findById.mockResolvedValue(onboarding);
    repository.accountActivation.mockResolvedValue({ activatedAt: new Date(now.getTime() - DAY), label: 'MG Road wall' });
    const second = await watchRetention(now);
    expect(second.activated).toBe(1);
    expect(repository.update.mock.calls.some((call) => (call[1] as { stage?: string }).stage === 'ACTIVATED' && (call[1] as { activatedAt?: Date }).activatedAt instanceof Date)).toBe(true);
    expect(payouts.recordIncentiveOnce).toHaveBeenCalledWith(expect.objectContaining({ event: 'LEAD_ACTIVATED', agentId: 'agt_1', tier: 'SILVER', side: 'PUBLISHER', publisherId: 'pub_1' }));
  });

  it('retains on a second booking, or thirty days live, and pays LEAD_RETAINED for an advertiser at its side', async () => {
    const activated = lead({ side: 'ADVERTISER', stage: 'ACTIVATED', status: 'CONVERTED', convertedAdvertiserId: 'adv_1', activatedAt: new Date(now.getTime() - 3 * DAY) });
    repository.findAtStages.mockResolvedValueOnce([activated]).mockResolvedValueOnce([]);
    repository.findById.mockResolvedValue(activated);
    repository.accountRetention.mockResolvedValue({ repeatCount: 1, stillLive: true });
    expect((await watchRetention(now)).retained).toBe(0);

    vi.clearAllMocks();
    repository.findAtStages.mockResolvedValueOnce([activated]).mockResolvedValueOnce([]);
    repository.findById.mockResolvedValue(activated);
    repository.accountRetention.mockResolvedValue({ repeatCount: 2, stillLive: true });
    expect((await watchRetention(now)).retained).toBe(1);
    expect(payouts.recordIncentiveOnce).toHaveBeenCalledWith(expect.objectContaining({ event: 'LEAD_RETAINED', side: 'ADVERTISER', advertiserId: 'adv_1' }));

    vi.clearAllMocks();
    const old = lead({ side: 'ADVERTISER', stage: 'ACTIVATED', status: 'CONVERTED', convertedAdvertiserId: 'adv_1', activatedAt: new Date(now.getTime() - 31 * DAY) });
    repository.findAtStages.mockResolvedValueOnce([old]).mockResolvedValueOnce([]);
    repository.findById.mockResolvedValue(old);
    repository.accountRetention.mockResolvedValue({ repeatCount: 1, stillLive: true });
    expect((await watchRetention(now)).retained).toBe(1);
  });

  it('LH8 (D2): an activation stamps the holder onto an account that names no agent, so the rung counts it — and says so on the lead', async () => {
    const onboarding = lead({ stage: 'ONBOARDING', status: 'CONVERTED', convertedPublisherId: 'pub_1' });
    repository.findAtStages.mockResolvedValueOnce([onboarding]).mockResolvedValueOnce([]);
    repository.findById.mockResolvedValue(onboarding);
    repository.accountActivation.mockResolvedValue({ activatedAt: now, label: 'MG Road wall' });
    repository.attributeAccountToAgent.mockResolvedValueOnce('PUBLISHER');
    await watchRetention(now);
    expect(repository.attributeAccountToAgent).toHaveBeenCalledWith({ publisherId: 'pub_1', advertiserId: null }, 'agt_1');
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'led_1', note: 'Counted toward the tier ladder (D2)' }));

    // An account that already carries the agent who brought it in is left alone, and nothing is written on the lead.
    vi.clearAllMocks();
    repository.findAtStages.mockResolvedValueOnce([onboarding]).mockResolvedValueOnce([]);
    repository.findById.mockResolvedValue(onboarding);
    repository.accountActivation.mockResolvedValue({ activatedAt: now, label: 'MG Road wall' });
    repository.attributeAccountToAgent.mockResolvedValueOnce(null);
    await watchRetention(now);
    expect(repository.logActivity.mock.calls.some((call) => (call[0] as { note?: string }).note === 'Counted toward the tier ladder (D2)')).toBe(false);
  });

  it('a lead with no agent activates without paying anybody', async () => {
    const orphan = lead({ stage: 'ONBOARDING', status: 'CONVERTED', convertedPublisherId: 'pub_1', assignedAgentId: null });
    repository.findAtStages.mockResolvedValueOnce([orphan]).mockResolvedValueOnce([]);
    repository.findById.mockResolvedValue(orphan);
    repository.accountActivation.mockResolvedValue({ activatedAt: now, label: 'x' });
    expect((await watchRetention(now)).activated).toBe(1);
    expect(payouts.recordIncentiveOnce).not.toHaveBeenCalled();
    expect(repository.attributeAccountToAgent).not.toHaveBeenCalled();
  });
});

describe('the recycle', () => {
  it('brings a due loss back to SCORED, unassigned, with the note, and re-scores it', async () => {
    const lost = lead({ stage: 'LOST', status: 'LOST', lostReason: 'TIMING', stageChangedAt: new Date(now.getTime() - 61 * DAY), recycleAt: new Date(now.getTime() - DAY) });
    repository.dueForRecycle.mockResolvedValue([lost]);
    repository.findById.mockResolvedValue(lost);
    expect(await recycleDue(now)).toEqual({ recycled: 1 });
    expect(repository.update.mock.calls[0]![1]).toMatchObject({ stage: 'SCORED', status: 'NEW', lostReason: null, recycleAt: null });
    expect(repository.update).toHaveBeenCalledWith('led_1', expect.objectContaining({ assignedAgentId: null }));
    // LH9: the stamp the overview's recycle yield and LH11's board flag read.
    expect(repository.update).toHaveBeenCalledWith('led_1', expect.objectContaining({ recycledAt: now, recycleCount: 1 }));
    expect(repository.logActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'STAGE_CHANGED', note: expect.stringContaining('recycled after 61 days (timing)') }));
    expect(repository.update.mock.calls.some((call) => 'lastTouchedAt' in (call[1] as object))).toBe(true);
  });

  it('LH11: a recycled lead starts a fresh sequence through the port, and a port that fails does not stop the recycle', async () => {
    const onRecycled = vi.fn(async () => undefined);
    registerLeadRecyclePort({ onRecycled });
    const lost = lead({ stage: 'LOST', status: 'LOST', lostReason: 'PRICE', stageChangedAt: new Date(now.getTime() - 61 * DAY), recycleAt: new Date(now.getTime() - DAY) });
    repository.dueForRecycle.mockResolvedValue([lost]);
    repository.findById.mockResolvedValue(lost);
    expect(await recycleDue(now)).toEqual({ recycled: 1 });
    expect(onRecycled).toHaveBeenCalledWith('led_1');

    vi.clearAllMocks();
    registerLeadRecyclePort({ onRecycled: vi.fn(async () => { throw new Error('no sequence'); }) });
    repository.dueForRecycle.mockResolvedValue([lost]);
    repository.findById.mockResolvedValue(lost);
    expect(await recycleDue(now)).toEqual({ recycled: 1 });
  });
});

describe('the funnel and the bodies', () => {
  it('keys the city and hands the filter to the repository', async () => {
    repository.funnel.mockResolvedValue({ byStage: [], totals: { leads: 0 } });
    await funnel({ side: 'PUBLISHER', city: 'bengaluru' });
    expect(repository.funnel).toHaveBeenCalledWith({ side: 'PUBLISHER', city: 'bengaluru', cityId: 'city_blr' });
    expect(funnelQuerySchema.parse({ from: '2026-09-01', to: '2026-09-30' }).from).toBeInstanceOf(Date);
  });

  it('reads the desk’s move and the agent’s loss', () => {
    expect(moveStageSchema.safeParse({ stage: 'ENGAGED' }).success).toBe(true);
    expect(moveStageSchema.safeParse({ stage: 'ELSEWHERE' }).success).toBe(false);
    expect(markLostSchema.safeParse({ reason: 'TIMING' }).success).toBe(true);
    expect(markLostSchema.safeParse({}).success).toBe(false);
  });
});
