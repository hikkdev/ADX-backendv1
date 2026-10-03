import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 05 — the milestone board, derived on read.
 *
 * Pinned: progress comes from the counters, not the row; the row's cache is
 * written only when it moved; `completedAt` is stamped the first time the
 * target is reached and never again; the claim records a MILESTONE_BONUS at
 * the template's reward through `recordIncentive`, once, and only on a
 * completed milestone; a template created through the API can be created
 * inactive and ordered; and the reward is a decimal string end to end.
 */

const { repository, agents, payouts, compensation } = vi.hoisted(() => ({
  repository: {
    findActiveTemplates: vi.fn(),
    findTemplates: vi.fn(),
    findTemplate: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    findAgent: vi.fn(),
    ensureAgentMilestone: vi.fn(),
    findForAgent: vi.fn(),
    findById: vi.fn(),
    writeDerived: vi.fn(),
    claim: vi.fn(),
    countOnboarded: vi.fn(),
    countActivity: vi.fn(),
    sumCreditedIncentives: vi.fn(),
    countOnTimeArrivals: vi.fn(),
    countLeadConversions: vi.fn(),
    countLeadContacts: vi.fn(),
    hasTemplateOfType: vi.fn(),
  },
  agents: { requireAgentProfile: vi.fn(), findAgentProfile: vi.fn() },
  payouts: { recordIncentive: vi.fn() },
  /* CP-5: the quota tracker is the compensation module's standing. Mocked
     here so the board's own derivation is what this file tests, and so a
     unit test never reaches for a database to find out what day it is. */
  compensation: { standingFor: vi.fn() },
}));

vi.mock('../milestones/prisma-agent-milestones.repository', () => ({ prismaAgentMilestonesRepository: repository }));
vi.mock('../agents.service', () => agents);
vi.mock('../../payouts', () => ({ recordIncentive: payouts.recordIncentive }));
vi.mock('../compensation/compensation.service', () => compensation);

import { Decimal } from '../../../shared/money';
import {
  claimMilestone,
  createMilestoneTemplate,
  ensureLeadMilestoneTemplates,
  getMilestoneBoard,
  LEAD_MILESTONE_TEMPLATES,
  patchMilestoneTemplate,
} from '../milestones/agent-milestones.service';
import { createMilestoneTemplateSchema } from '../milestones/agent-milestones.schema';

const NOW = new Date('2026-09-11T06:00:00.000Z');
const day = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

const template = (over: Record<string, unknown> = {}) => ({
  id: 'tpl_onb',
  type: 'ONBOARDING',
  title: 'Onboard 10 publishers',
  description: 'Onboard publishers to unlock bonuses',
  target: 10,
  rewardAmount: new Decimal('5000.00'),
  sortOrder: 1,
  isActive: true,
  windowDays: 30,
  startsAt: null,
  unlockAfter: null,
  createdAt: day(-40),
  updatedAt: day(-40),
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ms_1',
  agentId: 'agt_1',
  templateId: 'tpl_onb',
  progress: 3,
  computedAt: null,
  completedAt: null,
  claimedAt: null,
  incentiveId: null,
  createdAt: day(-20),
  updatedAt: day(-20),
  template: template(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  agents.requireAgentProfile.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent', tier: 'SILVER' });
  agents.findAgentProfile.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent', tier: 'SILVER' });
  repository.findActiveTemplates.mockResolvedValue([template()]);
  repository.ensureAgentMilestone.mockResolvedValue({});
  repository.findForAgent.mockResolvedValue([row()]);
  repository.writeDerived.mockResolvedValue({});
  repository.countOnboarded.mockResolvedValue(7);
  repository.countActivity.mockResolvedValue(0);
  repository.sumCreditedIncentives.mockResolvedValue(new Decimal(0));
  repository.countOnTimeArrivals.mockResolvedValue(0);
  repository.countLeadConversions.mockResolvedValue(0);
  repository.countLeadContacts.mockResolvedValue(0);
  repository.hasTemplateOfType.mockResolvedValue(false);
  payouts.recordIncentive.mockResolvedValue({ id: 'inc_1', amount: new Decimal('5000.00'), status: 'PENDING_VERIFICATION' });
  repository.claim.mockImplementation(async (_id, data) => row({ ...data, completedAt: NOW }));
  // CP-5: by default the agent is not on the quota model, which is every
  // agent before CP-1 and keeps every test below reading the old board.
  compensation.standingFor.mockResolvedValue({ onTheQuotaModel: false, dailyQuota: null });
});

/** CP-5: an agent on the salary-and-quota model, as `standingFor` answers. */
const standing = (over: Record<string, unknown> = {}) => ({
  agentId: 'agt_1',
  day: '2026-09-11',
  month: '2026-09',
  onTheQuotaModel: true,
  dailyQuota: 10,
  workingDaysPerMonth: 26,
  doneToday: 7,
  quotaLeftToday: 3,
  doneThisMonth: 120,
  monthlySalary: '25000.00',
  plannedUnitCost: '96.15',
  commissionPerExtra: '105.77',
  salaryPerOnboarding: '208.33',
  ...over,
});

/**
 * CP-5 — the daily quota is a tracker, not a milestone.
 *
 * The owner's model pays the quota through the salary. So the quota appears
 * on the board (it is what the agent is working against all day) but it can
 * never be claimed, and a milestone whose target sits INSIDE the planned
 * month is flagged, because paying a bonus for it would pay twice for work
 * the salary already bought.
 */
describe('CP-5: the quota beside the milestones', () => {
  it('draws the day\'s quota as an unclaimable tracker, with what the next one past it earns', async () => {
    compensation.standingFor.mockResolvedValue(standing());
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(board.quota).toEqual({
      day: '2026-09-11',
      target: 10,
      progress: 7,
      leftToday: 3,
      pct: 70,
      claimable: false,
      commissionPerExtra: '105.77',
      plannedPerMonth: 260,
    });
  });

  it('has no tracker for an agent off the quota model, rather than one measured against nothing', async () => {
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(board.quota).toBeNull();
  });

  it('never fails the board over the tracker', async () => {
    compensation.standingFor.mockRejectedValue(new Error('the pay read fell over'));
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(board.quota).toBeNull();
    expect(board.milestones).toHaveLength(1);
  });

  it('flags an onboarding milestone whose target sits inside the planned month', async () => {
    // Ten a day over twenty-six days is 260 planned; a target of 10 is bought and paid for already.
    compensation.standingFor.mockResolvedValue(standing());
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(board.milestones[0]!.stretch).toBe(false);
  });

  it('calls a target above the planned month a stretch, which is what a bonus is for', async () => {
    compensation.standingFor.mockResolvedValue(standing());
    repository.findForAgent.mockResolvedValue([row({ template: template({ target: 300 }) })]);
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(board.milestones[0]!.stretch).toBe(true);
  });

  it('judges nothing when the agent is off the model, or when the milestone does not count onboardings', async () => {
    const off = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(off.milestones[0]!.stretch).toBeNull();

    compensation.standingFor.mockResolvedValue(standing());
    repository.findForAgent.mockResolvedValue([row({ template: template({ type: 'REVENUE', target: 5 }) })]);
    const revenue = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(revenue.milestones[0]!.stretch).toBeNull();
  });
});

describe('the board', () => {
  it('derives progress from the counters, not the row, inside the template\'s window', async () => {
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    const card = board.milestones[0]!;
    expect(card.progress).toBe(7); // the counter, not the row's cached 3
    expect(card.pct).toBe(70);
    expect(card.state).toBe('ACTIVE');
    expect(card.timing).toBe('Due in 10 days');
    expect(card.deadlineLabel).toBe('21st SEP');
    expect(card.reward).toBe('5000.00');
    expect(card.link).toBe('LEADS');
    // The window ran from the agent's own row: a length with no start.
    const [, window] = repository.countOnboarded.mock.calls[0]!;
    expect(window.from).toEqual(day(-20));
    expect(window.to).toEqual(day(10));
  });

  it('writes the cache when the derivation moved, and stamps the first completion', async () => {
    repository.countOnboarded.mockResolvedValue(10);
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(board.milestones[0]!.state).toBe('COMPLETED');
    expect(board.claimable?.id).toBe('ms_1');
    expect(repository.writeDerived).toHaveBeenCalledWith('ms_1', { progress: 10, completedAt: NOW, computedAt: NOW });
  });

  it('does not write when nothing moved', async () => {
    repository.countOnboarded.mockResolvedValue(3);
    await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(repository.writeDerived).not.toHaveBeenCalled();
  });

  it('never re-stamps a completion', async () => {
    repository.findForAgent.mockResolvedValue([row({ progress: 10, completedAt: day(-3) })]);
    repository.countOnboarded.mockResolvedValue(12);
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(repository.writeDerived).toHaveBeenCalledWith('ms_1', { progress: 12, computedAt: NOW });
    expect(board.milestones[0]!.completedAt).toBe(day(-3).toISOString());
    expect(board.milestones[0]!.progress).toBe(10); // capped at the target on the card
  });

  it('files a REVENUE milestone in rupees and prints the amount as money', async () => {
    repository.findActiveTemplates.mockResolvedValue([template({ id: 'tpl_rev', type: 'REVENUE', target: 50000 })]);
    repository.findForAgent.mockResolvedValue([row({ id: 'ms_rev', templateId: 'tpl_rev', template: template({ id: 'tpl_rev', type: 'REVENUE', target: 50000 }) })]);
    repository.sumCreditedIncentives.mockResolvedValue(new Decimal('32000.50'));
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    expect(board.milestones[0]!.progress).toBe(32000);
    expect(board.milestones[0]!.progressAmount).toBe('32000.50');
    expect(board.milestones[0]!.link).toBe('EARNINGS');
  });

  it('locks a milestone until enough others are complete, and counts completions for the unlock', async () => {
    const locked = template({ id: 'tpl_q', type: 'QUALITY', target: 20, unlockAfter: 2, windowDays: null });
    repository.findActiveTemplates.mockResolvedValue([template(), locked]);
    repository.findForAgent.mockResolvedValue([
      row({ completedAt: day(-3), progress: 10 }),
      row({ id: 'ms_q', templateId: 'tpl_q', template: locked }),
    ]);
    repository.countOnboarded.mockResolvedValue(10);
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    const q = board.milestones.find((m) => m.id === 'ms_q')!;
    expect(q.state).toBe('LOCKED');
    expect(q.timing).toBe('Complete 2 milestones first');
    expect(board.counts).toEqual({ ALL: 2, ACTIVE: 0, UPCOMING: 1, COMPLETED: 1 });
  });

  it('filters by chip and counts over the whole board', async () => {
    const board = await getMilestoneBoard('usr_agent', 'COMPLETED', NOW);
    expect(board.milestones).toEqual([]);
    expect(board.counts.ACTIVE).toBe(1);
    expect(board.active?.id).toBe('ms_1');
  });
});

describe('the claim', () => {
  it('records a MILESTONE_BONUS at the template\'s reward, once, and returns the receipt', async () => {
    repository.findById.mockResolvedValue(row({ progress: 10, completedAt: day(-1) }));
    repository.countOnboarded.mockResolvedValue(10);
    const result = await claimMilestone('ms_1', 'usr_agent', NOW);
    expect(payouts.recordIncentive).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_1', event: 'MILESTONE_BONUS', tier: 'SILVER', amount: '5000.00' }),
      NOW,
    );
    expect(repository.claim).toHaveBeenCalledWith('ms_1', { claimedAt: NOW, incentiveId: 'inc_1' });
    expect(result.milestone.state).toBe('CLAIMED');
    expect(result.receipt).toEqual({ incentiveId: 'inc_1', amount: '5000.00', status: 'PENDING_VERIFICATION', at: NOW.toISOString() });
  });

  it('completes on the way through when the cache has not caught up', async () => {
    repository.findById.mockResolvedValue(row({ progress: 9 }));
    repository.countOnboarded.mockResolvedValue(10);
    await claimMilestone('ms_1', 'usr_agent', NOW);
    expect(repository.writeDerived).toHaveBeenCalledWith('ms_1', { progress: 10, completedAt: NOW, computedAt: NOW });
    expect(payouts.recordIncentive).toHaveBeenCalled();
  });

  it('refuses an incomplete milestone', async () => {
    repository.findById.mockResolvedValue(row());
    repository.countOnboarded.mockResolvedValue(7);
    await expect(claimMilestone('ms_1', 'usr_agent', NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect(payouts.recordIncentive).not.toHaveBeenCalled();
  });

  it('refuses a second claim', async () => {
    repository.findById.mockResolvedValue(row({ completedAt: day(-1), claimedAt: day(-1), incentiveId: 'inc_0' }));
    await expect(claimMilestone('ms_1', 'usr_agent', NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('is somebody else\'s milestone, so it is refused', async () => {
    repository.findById.mockResolvedValue(row({ agentId: 'agt_other', completedAt: day(-1) }));
    await expect(claimMilestone('ms_1', 'usr_agent', NOW)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the lead milestones (LH8)', () => {
  it('derives a LEAD_CONVERSIONS card from the conversions counter and a LEAD_CONTACTS card from the first contacts, both linking to the hunt', async () => {
    const conversions = template({ id: 'tpl_conv', type: 'LEAD_CONVERSIONS', title: '5 lead conversions this month', target: 5, windowDays: 30, rewardAmount: new Decimal('1500.00') });
    const contacts = template({ id: 'tpl_contact', type: 'LEAD_CONTACTS', title: '10 first contacts this week', target: 10, windowDays: 7, rewardAmount: new Decimal('300.00') });
    repository.findActiveTemplates.mockResolvedValue([conversions, contacts]);
    repository.findForAgent.mockResolvedValue([
      row({ id: 'ms_conv', templateId: 'tpl_conv', progress: 0, template: conversions }),
      row({ id: 'ms_contact', templateId: 'tpl_contact', progress: 0, template: contacts, createdAt: day(-3) }),
    ]);
    repository.countLeadConversions.mockResolvedValue(3);
    repository.countLeadContacts.mockResolvedValue(10);
    const board = await getMilestoneBoard('usr_agent', 'ALL', NOW);
    const [conv, contact] = board.milestones;
    expect(conv).toMatchObject({ type: 'LEAD_CONVERSIONS', progress: 3, pct: 60, state: 'ACTIVE', link: 'LEADS', reward: '1500.00' });
    expect(contact).toMatchObject({ type: 'LEAD_CONTACTS', progress: 10, state: 'COMPLETED', link: 'LEADS', claimable: true });
    // Counted by the holder inside the row's own window.
    expect(repository.countLeadConversions).toHaveBeenCalledWith('agt_1', { from: day(-20), to: day(10) });
    expect(repository.countLeadContacts).toHaveBeenCalledWith('agt_1', { from: day(-3), to: day(4) });
    expect(repository.countOnboarded).not.toHaveBeenCalled();
  });

  it('seeds the two templates once per type, and never hands back one the desk retired', async () => {
    repository.createTemplate.mockImplementation(async (data) => template({ ...data, id: `tpl_${data.type}` }));
    expect(await ensureLeadMilestoneTemplates()).toBe(2);
    expect(repository.createTemplate).toHaveBeenCalledTimes(2);
    expect(repository.createTemplate.mock.calls.map(([data]) => [data.type, data.title, data.target, data.windowDays, data.rewardAmount.toFixed(2), data.isActive])).toEqual([
      ['LEAD_CONVERSIONS', '5 lead conversions this month', 5, 30, '1500.00', true],
      ['LEAD_CONTACTS', '10 first contacts this week', 10, 7, '300.00', true],
    ]);

    vi.clearAllMocks();
    // One of the types exists (active or not): only the other is seeded.
    repository.hasTemplateOfType.mockImplementation(async (type: string) => type === 'LEAD_CONVERSIONS');
    expect(await ensureLeadMilestoneTemplates()).toBe(1);
    expect(repository.createTemplate.mock.calls[0]![0].type).toBe('LEAD_CONTACTS');
    expect(LEAD_MILESTONE_TEMPLATES.map((t) => t.type)).toEqual(['LEAD_CONVERSIONS', 'LEAD_CONTACTS']);
  });

  it('the desk may create either type, lower-cased or not', () => {
    expect(createMilestoneTemplateSchema.parse({ type: 'lead_contacts', title: 'x', description: 'y', target: 3, rewardAmount: '100' }).type).toBe('LEAD_CONTACTS');
    expect(createMilestoneTemplateSchema.parse({ type: 'LEAD_CONVERSIONS', title: 'x', description: 'y', target: 3, rewardAmount: '100' }).type).toBe('LEAD_CONVERSIONS');
  });
});

describe('templates', () => {
  it('can be created inactive, ordered and windowed — and the reward is a decimal string', async () => {
    const input = createMilestoneTemplateSchema.parse({
      type: 'activity',
      title: 'Complete 10 visits',
      description: 'Field visits and verifications',
      target: 10,
      rewardAmount: '3000',
      isActive: false,
      sortOrder: 5,
      windowDays: 30,
      unlockAfter: 1,
    });
    repository.createTemplate.mockImplementation(async (data) => template({ ...data, id: 'tpl_new' }));
    const view = await createMilestoneTemplate(input);
    const [data] = repository.createTemplate.mock.calls[0]!;
    expect(data.isActive).toBe(false);
    expect(data.sortOrder).toBe(5);
    expect(data.rewardAmount).toBeInstanceOf(Decimal);
    expect(view.rewardAmount).toBe('3000.00');
  });

  it('refuses a float reward', () => {
    expect(createMilestoneTemplateSchema.safeParse({ type: 'ACTIVITY', title: 'x', description: 'y', target: 1, rewardAmount: 3000 }).success).toBe(false);
  });

  it('patches only what was sent', async () => {
    repository.findTemplate.mockResolvedValue(template());
    repository.updateTemplate.mockImplementation(async (_id, patch) => template(patch));
    await patchMilestoneTemplate('tpl_onb', { isActive: false, startsAt: null });
    expect(repository.updateTemplate).toHaveBeenCalledWith('tpl_onb', { isActive: false, startsAt: null });
  });
});
