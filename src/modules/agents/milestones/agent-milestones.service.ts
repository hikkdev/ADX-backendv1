import type { MilestoneTemplate, MilestoneType } from '../../../shared/database';
import { ApiError } from '../../../shared/errors';
import { Decimal, money, type Money } from '../../../shared/money';
import { recordIncentive } from '../../payouts';
import { findAgentProfile, requireAgentProfile } from '../agents.service';
import { prismaAgentMilestonesRepository as repository } from './prisma-agent-milestones.repository';
import type {
  AgentMilestoneWithTemplate,
  MilestoneTemplatePatch,
  NewMilestoneTemplate,
} from './agent-milestones.repository';
import type { CreateMilestoneTemplateInput, PatchMilestoneTemplateInput } from './agent-milestones.schema';
import {
  chipOf,
  deadlineLabel,
  milestoneChipOf,
  pctOf,
  rupeesProgress,
  stateOf,
  timingOf,
  windowOf,
  type MilestoneChip,
  type MilestoneState,
} from './milestone.rules';

/**
 * An agent's milestone board.
 *
 * Progress is DERIVED ON READ from the counters that already exist — the
 * ladder's onboarding count, completed field visits and accepted
 * verifications, credited incentives, on-time arrivals — and the row's
 * `progress` is a cache of that derivation, never a source (the AgentRating
 * rule, decision 3 of DR 07). `incrementMilestoneProgress`, the hook nobody
 * called, is gone: a hook that must be remembered in four modules is a hook
 * that will be forgotten, and the board would drift from the facts.
 *
 * Rows are still materialised lazily: every active template the agent has no
 * row for is created on read, so adding a template makes it appear for
 * everyone without a backfill.
 */

/** Where VIEW LEADS on the tracker goes — what counts toward this milestone. */
export type MilestoneLink = 'LEADS' | 'VISITS' | 'EARNINGS' | 'RATING';

const LINK_FOR: Record<MilestoneType, MilestoneLink> = {
  ONBOARDING: 'LEADS',
  ACTIVITY: 'VISITS',
  REVENUE: 'EARNINGS',
  QUALITY: 'RATING',
  // LH8: both lead types land on the hunt.
  LEAD_CONVERSIONS: 'LEADS',
  LEAD_CONTACTS: 'LEADS',
};

/**
 * LH8: the two lead milestones the brief names, seeded once per type when
 * no template of that type exists (active or not — a desk that retired one
 * is not handed it back). The rewards are defaults the desk edits: five
 * conversions at ₹100 each (D1) is ₹500 of hunt pay, so the bonus is set at
 * three times that; ten first contacts a week is the habit the funnel runs
 * on, worth a small weekly bonus.
 */
export const LEAD_MILESTONE_TEMPLATES: ReadonlyArray<Omit<NewMilestoneTemplate, 'startsAt' | 'unlockAfter' | 'isActive'>> = [
  { type: 'LEAD_CONVERSIONS', title: '5 lead conversions this month', description: 'Five leads you hold become accounts inside thirty days.', target: 5, rewardAmount: new Decimal('1500.00'), sortOrder: 5, windowDays: 30 },
  { type: 'LEAD_CONTACTS', title: '10 first contacts this week', description: 'Log the first contact on ten leads you hold inside seven days.', target: 10, rewardAmount: new Decimal('300.00'), sortOrder: 6, windowDays: 7 },
];

export async function ensureLeadMilestoneTemplates(): Promise<number> {
  let seeded = 0;
  for (const template of LEAD_MILESTONE_TEMPLATES) {
    if (await repository.hasTemplateOfType(template.type)) continue;
    await repository.createTemplate({ ...template, isActive: true, startsAt: null, unlockAfter: null });
    seeded += 1;
  }
  return seeded;
}

export type MilestoneCard = {
  id: string;
  templateId: string;
  type: MilestoneType;
  title: string;
  description: string;
  target: number;
  progress: number;
  /** REVENUE only: the rupees behind `progress`, as money. */
  progressAmount: Money | null;
  pct: number;
  /** "₹5,000 REWARD", as money. */
  reward: Money;
  state: MilestoneState;
  chip: { label: string; tone: string };
  /** The line under the title — "Due in 10 days", "Complete 2 milestones first". */
  timing: string | null;
  startsAt: string | null;
  deadline: string | null;
  /** "30th APR" on the tracker, when there is a deadline. */
  deadlineLabel: string | null;
  completedAt: string | null;
  claimedAt: string | null;
  /** Completed and not yet claimed. */
  claimable: boolean;
  link: MilestoneLink;
};

export type MilestoneBoard = {
  tier: string;
  milestones: MilestoneCard[];
  /** The claim strip: the first completed, unclaimed milestone. */
  claimable: MilestoneCard | null;
  /** The pinned tracker: the first active milestone. */
  active: MilestoneCard | null;
  counts: Record<MilestoneChip, number>;
};

export type TemplateView = {
  id: string;
  type: MilestoneType;
  title: string;
  description: string;
  target: number;
  rewardAmount: Money;
  sortOrder: number;
  isActive: boolean;
  windowDays: number | null;
  startsAt: string | null;
  unlockAfter: number | null;
  createdAt: string;
  updatedAt: string;
};

export function toTemplateView(row: MilestoneTemplate): TemplateView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    target: row.target,
    rewardAmount: money(row.rewardAmount),
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    windowDays: row.windowDays,
    startsAt: row.startsAt?.toISOString() ?? null,
    unlockAfter: row.unlockAfter,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Derived = { progress: number; amount: Money | null };

async function derive(
  row: AgentMilestoneWithTemplate,
  agent: { id: string; userId: string },
): Promise<Derived> {
  const window = windowOf(row.template, row);
  switch (row.template.type) {
    case 'ONBOARDING':
      return { progress: await repository.countOnboarded(agent.id, window), amount: null };
    case 'ACTIVITY':
      return { progress: await repository.countActivity(agent.id, agent.userId, window), amount: null };
    case 'REVENUE': {
      const { progress, amount } = rupeesProgress(await repository.sumCreditedIncentives(agent.id, window));
      return { progress, amount };
    }
    case 'QUALITY':
      return { progress: await repository.countOnTimeArrivals(agent.id, window), amount: null };
    case 'LEAD_CONVERSIONS':
      return { progress: await repository.countLeadConversions(agent.id, window), amount: null };
    case 'LEAD_CONTACTS':
      return { progress: await repository.countLeadContacts(agent.id, window), amount: null };
  }
}

function toCard(
  row: AgentMilestoneWithTemplate,
  derived: Derived,
  completedByAgent: number,
  now: Date,
): MilestoneCard {
  const state = stateOf({ template: row.template, row, progress: derived.progress, completedByAgent, now });
  const { to } = windowOf(row.template, row);
  return {
    id: row.id,
    templateId: row.templateId,
    type: row.template.type,
    title: row.template.title,
    description: row.template.description,
    target: row.template.target,
    progress: Math.min(derived.progress, row.template.target),
    progressAmount: derived.amount,
    pct: pctOf(derived.progress, row.template.target),
    reward: money(row.template.rewardAmount),
    state,
    chip: milestoneChipOf(state),
    timing: timingOf({ state, template: row.template, row, now }),
    startsAt: row.template.startsAt?.toISOString() ?? null,
    deadline: to?.toISOString() ?? null,
    deadlineLabel: to ? deadlineLabel(to) : null,
    completedAt: row.completedAt?.toISOString() ?? null,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    claimable: state === 'COMPLETED',
    link: LINK_FOR[row.template.type],
  };
}

/**
 * Derives every row on the board, writes the cache where it moved, and
 * stamps `completedAt` the first time a derivation reaches the target.
 */
async function deriveBoard(agent: { id: string; userId: string; tier: string }, now: Date): Promise<MilestoneCard[]> {
  const templates = await repository.findActiveTemplates();
  await Promise.all(templates.map((template) => repository.ensureAgentMilestone(agent.id, template.id)));

  const rows = (await repository.findForAgent(agent.id)).filter((row) => row.template.isActive);
  const derived = await Promise.all(rows.map((row) => derive(row, agent)));

  await Promise.all(
    rows.map((row, i) => {
      const { progress } = derived[i]!;
      const reached = progress >= row.template.target;
      const completedAt = !row.completedAt && reached ? now : undefined;
      if (progress === row.progress && !completedAt) return null;
      if (completedAt) row.completedAt = completedAt;
      return repository.writeDerived(row.id, { progress, ...(completedAt ? { completedAt } : {}), computedAt: now });
    }),
  );

  // The unlock count is what the agent has finished, whatever they have claimed.
  const completedByAgent = rows.filter((row) => row.completedAt).length;
  return rows.map((row, i) => toCard(row, derived[i]!, completedByAgent, now));
}

function toBoard(tier: string, cards: MilestoneCard[], chip: MilestoneChip): MilestoneBoard {
  const counts: Record<MilestoneChip, number> = { ALL: cards.length, ACTIVE: 0, UPCOMING: 0, COMPLETED: 0 };
  for (const card of cards) {
    const filed = chipOf(card.state);
    if (filed) counts[filed] += 1;
  }
  return {
    tier,
    milestones: chip === 'ALL' ? cards : cards.filter((card) => chipOf(card.state) === chip),
    claimable: cards.find((card) => card.claimable) ?? null,
    active: cards.find((card) => card.state === 'ACTIVE') ?? null,
    counts,
  };
}

export async function getMilestoneBoard(userId: string, chip: MilestoneChip = 'ALL', now = new Date()) {
  const agent = await requireAgentProfile(userId);
  return toBoard(agent.tier, await deriveBoard({ id: agent.id, userId: agent.userId, tier: agent.tier }, now), chip);
}

/** The console's read of any agent's board — the same derivation, by agent id. */
export async function getMilestoneBoardForAgent(agentId: string, now = new Date()) {
  const agent = await findAgentProfileById(agentId);
  return toBoard(agent.tier, await deriveBoard({ id: agent.id, userId: agent.userId, tier: agent.tier }, now), 'ALL');
}

async function findAgentProfileById(agentId: string) {
  const agent = await repository.findAgent(agentId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  return agent;
}

/** The dashboard hero: "Milestone / Onboard 10 Publishers" is the first active one. */
export async function activeMilestoneFor(agent: { id: string; userId: string; tier: string }, now = new Date()) {
  const cards = await deriveBoard(agent, now);
  return cards.find((card) => card.state === 'ACTIVE') ?? null;
}

/**
 * The claim.
 *
 * Records the MILESTONE_BONUS through the same `recordIncentive` every other
 * incentive goes through — effective-dated, TDS withheld at earn time,
 * landing PENDING_VERIFICATION for finance to release. The amount is the
 * template's reward, which is why the card and the wallet agree. A milestone
 * claims once: the second call is a 409, and the table's own check says the
 * same thing in SQL.
 */
export async function claimMilestone(milestoneId: string, userId: string, now = new Date()) {
  const me = await findAgentProfile(userId);
  const row = await repository.findById(milestoneId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No such milestone');
  if (!me || row.agentId !== me.id) throw new ApiError(403, 'FORBIDDEN', 'That milestone is not yours');
  if (row.claimedAt) throw new ApiError(409, 'CONFLICT', 'That reward has already been claimed');

  // Derive before deciding: a completion the cache has not seen yet still counts.
  const derived = await derive(row, { id: me.id, userId });
  const reached = row.completedAt !== null || derived.progress >= row.template.target;
  if (!reached) throw new ApiError(409, 'CONFLICT', 'That milestone is not complete yet');
  if (!row.completedAt) {
    row.completedAt = now;
    await repository.writeDerived(row.id, { progress: derived.progress, completedAt: now, computedAt: now });
  }

  const reward = money(row.template.rewardAmount);
  const incentive = await recordIncentive(
    {
      agentId: me.id,
      event: 'MILESTONE_BONUS',
      tier: me.tier,
      amount: new Decimal(reward).gt(0) ? reward : null,
      note: `Milestone: ${row.template.title}`,
    },
    now,
  );

  const claimed = await repository.claim(row.id, { claimedAt: now, incentiveId: incentive.id });
  const card = toCard(claimed, derived, 1, now);
  return {
    milestone: card,
    /** The modal's receipt row. The money is recorded; ops release it. */
    receipt: {
      incentiveId: incentive.id,
      amount: money(incentive.amount),
      status: incentive.status,
      at: now.toISOString(),
    },
  };
}

/* ─── Templates (ADMIN) ────────────────────────────────────────────────── */

export async function listMilestoneTemplates() {
  return (await repository.findTemplates()).map(toTemplateView);
}

export async function getMilestoneTemplate(id: string) {
  const row = await repository.findTemplate(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No such milestone template');
  return toTemplateView(row);
}

export async function createMilestoneTemplate(input: CreateMilestoneTemplateInput) {
  const row = await repository.createTemplate({
    type: input.type as MilestoneType,
    title: input.title,
    description: input.description,
    target: input.target,
    rewardAmount: new Decimal(input.rewardAmount),
    sortOrder: input.sortOrder,
    isActive: input.isActive,
    windowDays: input.windowDays,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    unlockAfter: input.unlockAfter,
  });
  return toTemplateView(row);
}

export async function patchMilestoneTemplate(id: string, input: PatchMilestoneTemplateInput) {
  const existing = await repository.findTemplate(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'No such milestone template');
  const patch: MilestoneTemplatePatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.target !== undefined) patch.target = input.target;
  if (input.rewardAmount !== undefined) patch.rewardAmount = new Decimal(input.rewardAmount);
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.windowDays !== undefined) patch.windowDays = input.windowDays;
  if (input.startsAt !== undefined) patch.startsAt = input.startsAt ? new Date(input.startsAt) : null;
  if (input.unlockAfter !== undefined) patch.unlockAfter = input.unlockAfter;
  return toTemplateView(await repository.updateTemplate(id, patch));
}
