/**
 * The agent tier ladder — the "BRONZE III → SILVER I" the DR 01 dashboard
 * header draws, with the "3/10" step under it.
 *
 * `AgentProfile.tier` was a bare string defaulting to 'BRONZE' that nothing
 * ever wrote. The frames draw a tier, a sub-level within it, and progress
 * toward the next, so those have to be computed from something real: the
 * number of accounts the agent has actually brought through onboarding.
 * That is the one figure attribution already records (`Publisher.agentId`,
 * `Advertiser.agentId`), so it is the one the ladder climbs on.
 *
 * The thresholds below are PROVISIONAL. Nothing in the Figma file or the
 * backend defined them; they are stated here, once, so the product can change
 * them in one place without touching the header or the endpoint. When they
 * move to admin configuration this table becomes the default.
 */

export const AGENT_TIERS = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'] as const;
export const TIER_LEVELS = ['I', 'II', 'III'] as const;
export type TierName = (typeof AGENT_TIERS)[number];
export type TierLevel = (typeof TIER_LEVELS)[number];

export type Rung = { tier: TierName; level: TierLevel; from: number };

/** Climbs strictly; the first rung is where everyone starts. */
export const LADDER: readonly Rung[] = [
  { tier: 'BRONZE', level: 'I', from: 0 },
  { tier: 'BRONZE', level: 'II', from: 5 },
  { tier: 'BRONZE', level: 'III', from: 10 },
  { tier: 'SILVER', level: 'I', from: 20 },
  { tier: 'SILVER', level: 'II', from: 30 },
  { tier: 'SILVER', level: 'III', from: 45 },
  { tier: 'GOLD', level: 'I', from: 60 },
  { tier: 'GOLD', level: 'II', from: 80 },
  { tier: 'GOLD', level: 'III', from: 105 },
  { tier: 'PLATINUM', level: 'I', from: 130 },
];

export type LadderPosition = {
  tier: TierName;
  level: TierLevel;
  /** "Bronze III" — the way the frame prints it. */
  label: string;
  /** How many onboardings into this rung the agent is. */
  stepDone: number;
  /** How many this rung is wide — the "/10". Equals stepDone on the top rung. */
  stepTarget: number;
  /** The rung above, or null on the top one. */
  next: { tier: TierName; level: TierLevel; label: string } | null;
};

export function tierLabel(tier: TierName, level: TierLevel): string {
  return `${tier.charAt(0)}${tier.slice(1).toLowerCase()} ${level}`;
}

/**
 * Where a count of onboarded accounts puts an agent on the ladder — the
 * built-in one, or the thresholds ops have configured (DR 05), which must
 * have passed `validLadder` before they were stored.
 */
export function rungFor(onboarded: number, ladder: readonly Rung[] = LADDER): LadderPosition {
  const count = Math.max(0, Math.floor(onboarded));

  let index = 0;
  for (let i = 0; i < ladder.length; i += 1) {
    if (count >= ladder[i]!.from) index = i;
  }
  const rung = ladder[index]!;
  const above = ladder[index + 1] ?? null;

  const stepDone = count - rung.from;
  // The top rung has nowhere to go, so its step is simply what has been done.
  const stepTarget = above ? above.from - rung.from : stepDone;

  return {
    tier: rung.tier,
    level: rung.level,
    label: tierLabel(rung.tier, rung.level),
    stepDone: above ? Math.min(stepDone, stepTarget) : stepDone,
    stepTarget,
    next: above ? { tier: above.tier, level: above.level, label: tierLabel(above.tier, above.level) } : null,
  };
}

/** Higher rung, same rung or lower: the sign of a tier change. */
export function compareRungs(a: { tier: TierName; level: TierLevel }, b: { tier: TierName; level: TierLevel }): number {
  const rank = (r: { tier: TierName; level: TierLevel }) => AGENT_TIERS.indexOf(r.tier) * 3 + TIER_LEVELS.indexOf(r.level);
  return Math.sign(rank(a) - rank(b));
}

/**
 * Whether a configured ladder is one the rest of this file can climb: it
 * starts at zero, climbs strictly, and never repeats a rung. A ladder that
 * fails this is refused at the desk rather than stored and read as the
 * default forever after.
 */
export function validLadder(rungs: readonly Rung[]): string | null {
  if (rungs.length < 2) return 'A ladder needs at least two rungs';
  if (rungs[0]!.from !== 0) return 'The first rung starts at 0';
  const seen = new Set<string>();
  for (let i = 0; i < rungs.length; i += 1) {
    const rung = rungs[i]!;
    const key = `${rung.tier} ${rung.level}`;
    if (seen.has(key)) return `${key} appears twice`;
    seen.add(key);
    if (i > 0) {
      if (rung.from <= rungs[i - 1]!.from) return `${key} does not climb`;
      if (compareRungs(rung, rungs[i - 1]!) <= 0) return `${key} is not above ${rungs[i - 1]!.tier} ${rungs[i - 1]!.level}`;
    }
  }
  return null;
}
