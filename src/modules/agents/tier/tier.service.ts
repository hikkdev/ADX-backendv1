import type { AgentTier, AgentTierEvent, TierLevel } from '../../../shared/database';
import { logActivity } from '../../../shared/audit';
import { ApiError } from '../../../shared/errors';
import type { Money } from '../../../shared/money';
import { getConfigObject, saveConfigObject } from '../../app-config';
import { rateFor, recordIncentive } from '../../payouts';
import { prismaAgentsRepository as agents } from '../prisma-agents.repository';
import {
  AGENT_TIERS,
  LADDER,
  compareRungs,
  rungFor,
  tierLabel,
  validLadder,
  type LadderPosition,
  type Rung,
  type TierName,
} from '../tier-ladder';
import { prismaTierRepository as repository } from './prisma-tier.repository';
import type { TierProfile } from './tier.repository';

/**
 * The tier ladder, made real (DR 05).
 *
 * The rung is still derived from onboardings — that has not changed — but it
 * is now written back with its level, every change is an `AgentTierEvent`
 * (the GOLD Achieved screen fires on an unacknowledged one, once), the
 * thresholds can come from admin config with `LADDER` as the fallback, and
 * ops can pin a tier with a reason. A pinned tier is not recomputed on read.
 */

/** The `AppConfig` rows this module keeps. */
export const TIER_LADDER_KEY = 'tier-ladder';
export const SUPPORT_LINES_KEY = 'support-lines';

export type TierBenefit = {
  key: 'BONUS' | 'SUPPORT_LINE';
  title: string;
  detail: string;
};

export type TierView = {
  current: { tier: TierName; level: TierLevel; label: string; pinned: boolean };
  next: LadderPosition['next'];
  stepDone: number;
  stepTarget: number;
  onboarded: { publishers: number; advertisers: number; total: number };
  ladder: Rung[];
  /** What this rung actually gives — real or absent, never promised. */
  benefits: TierBenefit[];
  /** The promotion the app has not shown yet, or null. */
  promotion: TierEventView | null;
  history: TierEventView[];
};

export type TierEventView = {
  id: string;
  from: { tier: TierName; level: TierLevel; label: string };
  to: { tier: TierName; level: TierLevel; label: string };
  /** Up, down, or an ops pin at the same rung. */
  direction: 'UP' | 'DOWN' | 'SAME';
  reason: string;
  at: string;
  acknowledgedAt: string | null;
};

export function toTierEventView(row: AgentTierEvent): TierEventView {
  const from = { tier: row.fromTier, level: row.fromLevel, label: tierLabel(row.fromTier, row.fromLevel) };
  const to = { tier: row.toTier, level: row.toLevel, label: tierLabel(row.toTier, row.toLevel) };
  const cmp = compareRungs(to, from);
  return {
    id: row.id,
    from,
    to,
    direction: cmp > 0 ? 'UP' : cmp < 0 ? 'DOWN' : 'SAME',
    reason: row.reason,
    at: row.at.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
  };
}

/* ─── The ladder's thresholds ──────────────────────────────────────────── */

function parseLadder(value: Record<string, unknown> | null): Rung[] | null {
  const rungs = value?.['rungs'];
  if (!Array.isArray(rungs)) return null;
  const parsed: Rung[] = [];
  for (const entry of rungs) {
    const rung = entry as { tier?: unknown; level?: unknown; from?: unknown };
    if (!AGENT_TIERS.includes(rung.tier as TierName)) return null;
    if (!['I', 'II', 'III'].includes(rung.level as string)) return null;
    if (typeof rung.from !== 'number') return null;
    parsed.push({ tier: rung.tier as TierName, level: rung.level as TierLevel, from: rung.from });
  }
  return validLadder(parsed) ? null : parsed;
}

/** The configured thresholds, or the built-in table when none are stored or they are malformed. */
export async function loadLadder(): Promise<Rung[]> {
  const stored = await getConfigObject(TIER_LADDER_KEY).catch(() => null);
  return parseLadder(stored) ?? [...LADDER];
}

export async function saveLadder(rungs: Rung[]): Promise<Rung[]> {
  const problem = validLadder(rungs);
  if (problem) throw new ApiError(400, 'VALIDATION_ERROR', problem);
  await saveConfigObject(TIER_LADDER_KEY, { rungs });
  return rungs;
}

export async function loadSupportLines(): Promise<Partial<Record<TierName, string>>> {
  const stored = (await getConfigObject(SUPPORT_LINES_KEY).catch(() => null)) ?? {};
  const lines: Partial<Record<TierName, string>> = {};
  for (const tier of AGENT_TIERS) {
    const line = stored[tier];
    if (typeof line === 'string' && line.trim()) lines[tier] = line.trim();
  }
  return lines;
}

export async function saveSupportLines(lines: Partial<Record<TierName, string | null>>): Promise<Partial<Record<TierName, string>>> {
  const current = await loadSupportLines();
  for (const tier of AGENT_TIERS) {
    if (!(tier in lines)) continue;
    const line = lines[tier];
    if (line) current[tier] = line;
    else delete current[tier];
  }
  await saveConfigObject(SUPPORT_LINES_KEY, current);
  return current;
}

/**
 * What a rung gives. Decision 8: real or absent. The bonus is listed only
 * when a TIER_BONUS rate is configured for the tier — and worded as what it
 * is, an incentive recorded on promotion and released by ops, not instant
 * money. The support line is listed only when ops have stored a number for
 * the tier. "Priority lead assignment" is not listed: nothing assigns leads by
 * tier, and a benefit that is not delivered is a lie on a dark screen.
 */
export async function benefitsFor(tier: TierName, now = new Date()): Promise<TierBenefit[]> {
  const [bonus, lines] = await Promise.all([rateFor('TIER_BONUS', tier, now), loadSupportLines()]);
  const benefits: TierBenefit[] = [];
  if (bonus) {
    benefits.push({ key: 'BONUS', title: `₹${formatRupees(bonus)} bonus`, detail: 'Recorded on promotion — released by ADX finance' });
  }
  const line = lines[tier];
  if (line) benefits.push({ key: 'SUPPORT_LINE', title: 'Dedicated support line', detail: line });
  return benefits;
}

/** "10,000" from "10000.00" — the Indian grouping the frame prints, no paise when there are none. */
function formatRupees(amount: Money): string {
  const [whole, paise] = amount.split('.');
  const digits = whole ?? '0';
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return paise && paise !== '00' ? `${grouped}.${paise}` : grouped;
}

/* ─── The rung, kept current ───────────────────────────────────────────── */

/**
 * Where the ladder puts this agent, written back when it moved.
 *
 * Called on every dashboard read, as before — but a change is now a recorded
 * event, a promotion to a new tier records the TIER_BONUS the rate table
 * prices for it, and a pinned tier is left exactly where ops put it.
 */
export async function syncTier(
  profile: Pick<TierProfile, 'id' | 'tier' | 'tierLevel' | 'tierPinnedAt'>,
  onboarded: number,
  now = new Date(),
): Promise<{ position: LadderPosition; event: AgentTierEvent | null }> {
  const ladder = await loadLadder();
  const derived = rungFor(onboarded, ladder);

  if (profile.tierPinnedAt) {
    // The step under the header still counts; the rung is what ops said.
    return {
      position: { ...derived, tier: profile.tier, level: profile.tierLevel, label: tierLabel(profile.tier, profile.tierLevel) },
      event: null,
    };
  }

  if (derived.tier === profile.tier && derived.level === profile.tierLevel) {
    return { position: derived, event: null };
  }

  await repository.writeRung(profile.id, derived.tier, derived.level, null);
  const climbed = compareRungs(derived, { tier: profile.tier, level: profile.tierLevel }) > 0;
  const event = await repository.createEvent({
    agentId: profile.id,
    fromTier: profile.tier,
    fromLevel: profile.tierLevel,
    toTier: derived.tier,
    toLevel: derived.level,
    reason: climbed ? `Onboarded ${onboarded} ${onboarded === 1 ? 'account' : 'accounts'}` : `Ladder recomputed at ${onboarded} ${onboarded === 1 ? 'account' : 'accounts'}`,
    at: now,
  });

  // A new TIER (not a level within one) pays what the rate table says it
  // pays, when it says anything. Failing to record it must not fail the read.
  if (climbed && derived.tier !== profile.tier) {
    const rate = await rateFor('TIER_BONUS', derived.tier, now).catch(() => null);
    if (rate) {
      await recordIncentive(
        { agentId: profile.id, event: 'TIER_BONUS', tier: derived.tier, note: `Reached ${derived.label}` },
        now,
      ).catch(() => undefined);
    }
  }

  return { position: derived, event };
}

/* ─── The agent's own view ─────────────────────────────────────────────── */

export async function getMyTier(userId: string, now = new Date()): Promise<TierView> {
  const profile = await repository.findProfileByUser(userId);
  if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  return tierViewFor(profile, now);
}

/** The console's read: the same view, by agent id. */
export async function getTierForAgent(agentId: string, now = new Date()): Promise<TierView> {
  const profile = await repository.findProfile(agentId);
  if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  return tierViewFor(profile, now);
}

async function tierViewFor(profile: TierProfile, now: Date): Promise<TierView> {
  const counts = await agents.countOnboarded(profile.id);
  const total = counts.publishers + counts.advertisers;
  const { position } = await syncTier(profile, total, now);
  const [ladder, benefits, promotion, history] = await Promise.all([
    loadLadder(),
    benefitsFor(position.tier, now),
    repository.findUnacknowledged(profile.id),
    repository.listEvents(profile.id, 20),
  ]);
  const unseen = promotion ? toTierEventView(promotion) : null;
  return {
    current: { tier: position.tier, level: position.level, label: position.label, pinned: profile.tierPinnedAt !== null },
    next: position.next,
    stepDone: position.stepDone,
    stepTarget: position.stepTarget,
    onboarded: { ...counts, total },
    ladder,
    benefits,
    // Only a climb is celebrated; a fall or a pin is history, not a screen.
    promotion: unseen?.direction === 'UP' ? unseen : null,
    history: history.map(toTierEventView),
  };
}

/** The once: the GOLD Achieved screen is dismissed and does not come back. */
export async function acknowledgeTierEvent(userId: string, eventId: string, now = new Date()): Promise<TierEventView> {
  const profile = await repository.findProfileByUser(userId);
  if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  const event = await repository.findEvent(eventId);
  if (!event || event.agentId !== profile.id) throw new ApiError(404, 'NOT_FOUND', 'No such tier event');
  if (event.acknowledgedAt) return toTierEventView(event);
  return toTierEventView(await repository.acknowledge(eventId, now));
}

/* ─── Ops ──────────────────────────────────────────────────────────────── */

/**
 * Pins a tier. `PATCH /agents/:id` deliberately cannot write `tier`; this is
 * the explicit door — it needs a reason, it is an event, and it is logged.
 * Pinned, the read no longer recomputes the rung. Unpinning (`tier: null`)
 * hands the rung back to the ladder on the next read.
 */
export async function pinTier(
  agentId: string,
  input: { tier: AgentTier; level: TierLevel; reason: string } | { tier: null; reason: string },
  byUserId: string,
  now = new Date(),
): Promise<TierView> {
  const profile = await repository.findProfile(agentId);
  if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');

  if (input.tier === null) {
    if (!profile.tierPinnedAt) throw new ApiError(409, 'CONFLICT', 'That tier is not pinned');
    await repository.writeRung(agentId, profile.tier, profile.tierLevel, null);
    await logActivity(byUserId, 'AGENT_TIER_UNPINNED', undefined, { agentId, reason: input.reason });
    return tierViewFor({ ...profile, tierPinnedAt: null }, now);
  }

  await repository.writeRung(agentId, input.tier, input.level, now);
  await repository.createEvent({
    agentId,
    fromTier: profile.tier,
    fromLevel: profile.tierLevel,
    toTier: input.tier,
    toLevel: input.level,
    reason: input.reason,
    byUserId,
    at: now,
  });
  await logActivity(byUserId, 'AGENT_TIER_PINNED', undefined, {
    agentId,
    from: tierLabel(profile.tier, profile.tierLevel),
    to: tierLabel(input.tier, input.level),
    reason: input.reason,
  });
  return tierViewFor({ ...profile, tier: input.tier, tierLevel: input.level, tierPinnedAt: now }, now);
}
