import type { SuspensionScope } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { dayWindowIST } from '../../shared/time';
import type { Money } from '../../shared/money';
import { prismaAgentsRepository as repository } from './prisma-agents.repository';
import { leadLayer, type LeadCluster } from './lead-layer.port';
import { activeMilestoneFor, type MilestoneCard } from './milestones/agent-milestones.service';
import type { TierLevel, TierName } from './tier-ladder';
import { syncTier } from './tier/tier.service';

/**
 * GET /agents/me — everything the DR 01 dashboard draws above the map.
 *
 * The header ("3/10 Publishers onboarded", "BRONZE III → SILVER I"), the app
 * bar (city, wallet balance) and the day's counters come from here, in one
 * request, computed from what the platform actually records rather than from
 * fields nothing writes. The order card and the visit card are not here: the
 * app already reads `/orders/my` and `/agent/milestones` for those screens
 * and draws the card from the same answer.
 */

export type AgentSide = 'PUBLISHER' | 'ADVERTISER';

export type { LeadCluster } from './lead-layer.port';

export type AgentDashboard = {
  id: string;
  displayId: string | null;
  name: string | null;
  city: string | null;
  state: string | null;
  /** Which side(s) of the marketplace the agent sells for, publisher first. */
  sides: AgentSide[];
  tier: {
    name: TierName;
    level: TierLevel;
    label: string;
    next: { name: TierName; level: TierLevel; label: string } | null;
  };
  progress: {
    onboarded: { publishers: number; advertisers: number; total: number };
    /**
     * Lot B (Q100): what the agent has sold, beside what they onboarded.
     * Counters only — the ladder below climbs on `onboarded.total` and the
     * rating never reads these.
     */
    packagesSold: number;
    campaignsLaunched: number;
    /** The "3" of "3/10": onboardings into the current rung. */
    stepDone: number;
    /** The "10": how many this rung is wide. */
    stepTarget: number;
  };
  wallet: { balance: Money; currency: string };
  today: { orders: number; visits: number };
  /**
   * Lot A: which sections of this agent's work are suspended, and why. Carried
   * on the agent's own read so the app can say so rather than leaving them to
   * work out why no offers arrive.
   */
  suspension: {
    status: string;
    scopes: SuspensionScope[];
    reason: string | null;
    since: Date | null;
  };
  leads: LeadCluster[];
  /**
   * DR 05's hero line — "Milestone / Onboard 10 Publishers" — is the first
   * active milestone on the board, or null when there is none to chase.
   */
  milestone: MilestoneCard | null;
};

/** Publisher first: the app's default persona when an agent holds both roles. */
export function sidesFrom(roles: readonly string[]): AgentSide[] {
  const sides: AgentSide[] = [];
  if (roles.includes('AGENT_PUBLISHER')) sides.push('PUBLISHER');
  if (roles.includes('AGENT_ADVERTISER')) sides.push('ADVERTISER');
  return sides;
}

/** Re-exported for the tests and callers that reached it here before it moved to `shared/time`. */
export { dayWindowIST };

export async function getAgentDashboard(
  userId: string,
  now: Date = new Date(),
  /**
   * Where the agent is, when the app has told us.
   *
   * The map layer answers "near you", and without a point the honest fallback
   * is their city — a dashboard that shows nothing until location permission is
   * granted teaches people the feature is broken.
   */
  at?: { latitude: number; longitude: number; radiusKm: number },
): Promise<AgentDashboard> {
  const profile = await repository.findDashboardProfile(userId);
  if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const { start, end } = dayWindowIST(now);
  const [onboarded, wallet, today, sales] = await Promise.all([
    repository.countOnboarded(profile.id),
    repository.walletBalance(profile.id),
    repository.countToday(profile.id, start, end),
    // Two more counts, and neither may take the header down with it.
    repository.countSales(profile.id).catch(() => ({ packagesSold: 0, campaignsLaunched: 0 })),
  ]);

  // The map layer. Failing to draw bubbles must never fail the dashboard —
  // the header, the wallet and the day's counters are what the screen is for.
  const leads = await leadLayer()
    .clusters(at ? { point: at } : profile.city ? { city: profile.city } : { city: '' })
    .catch(() => []);

  // One ladder per agent: an agent who sells on both sides climbs on both.
  // The rung is written back here with its level — this read is still the
  // ladder's writer, but a change is now an AgentTierEvent and a pinned tier
  // is left where ops put it (DR 05).
  const total = onboarded.publishers + onboarded.advertisers;
  const { position: rung } = await syncTier(profile, total, now);

  // The hero's milestone is derived from the same counters, and a board that
  // cannot be derived must not take the header down with it.
  const milestone = await activeMilestoneFor({ id: profile.id, userId, tier: rung.tier }, now).catch(() => null);

  return {
    id: profile.id,
    displayId: profile.displayId,
    name: profile.name,
    city: profile.city,
    state: profile.state,
    sides: sidesFrom(profile.roles),
    tier: {
      name: rung.tier,
      level: rung.level,
      label: rung.label,
      next: rung.next ? { name: rung.next.tier, level: rung.next.level, label: rung.next.label } : null,
    },
    progress: {
      onboarded: { ...onboarded, total },
      packagesSold: sales.packagesSold,
      campaignsLaunched: sales.campaignsLaunched,
      stepDone: rung.stepDone,
      stepTarget: rung.stepTarget,
    },
    wallet,
    today,
    leads,
    milestone,
    suspension: {
      status: profile.status,
      scopes: profile.suspensionScopes,
      reason: profile.suspensionReason,
      since: profile.suspendedAt,
    },
  };
}
