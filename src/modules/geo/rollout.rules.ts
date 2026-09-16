import { ApiError } from '../../shared/errors';
import { CITY_FUNCTIONS, type CityFunction, type CityStageValue, type CitySwitches } from '../pricing';

/**
 * The stage machine — Lot V (the owner, 15 Sep 2026).
 *
 * "Why only 44? We plan to target entire India ... there should be better
 * control features so we can select what city to go into and launch ADX or
 * what city to pull our business out of, what city to gather our listing
 * from." So: every town in the catalogue, and five stages a city moves
 * through, each switching six functions on or off. No I/O here — the rules
 * are a table and three pure functions, so the transitions and the defaults
 * can be pinned without a database.
 *
 *   PLANNED    in the catalogue, nothing on
 *   SEEDING    gathering supply: listings created, imported and verified,
 *              agents onboarded, leads fed; nothing published, nothing sold
 *   LAUNCHED   open for business, everything on
 *   PAUSED     nothing new; what runs, runs (the campaigns complete)
 *   WITHDRAWN  out; the hourly wind-down takes the live listings down
 */

export const STAGE_TRANSITIONS: Readonly<Record<CityStageValue, readonly CityStageValue[]>> = {
  PLANNED: ['SEEDING', 'LAUNCHED'],
  SEEDING: ['LAUNCHED', 'PAUSED', 'WITHDRAWN'],
  LAUNCHED: ['PAUSED', 'WITHDRAWN'],
  PAUSED: ['LAUNCHED', 'WITHDRAWN'],
  // Re-entry. Nothing is republished on the way back in: the wind-down took
  // the listings INACTIVE and each publisher relists what they still have.
  WITHDRAWN: ['SEEDING', 'LAUNCHED'],
};

const ALL_OFF: CitySwitches = {
  supplyIntake: false,
  publishing: false,
  demand: false,
  agentOnboarding: false,
  printPartners: false,
  leadFeeds: false,
};
const ALL_ON: CitySwitches = {
  supplyIntake: true,
  publishing: true,
  demand: true,
  agentOnboarding: true,
  printPartners: true,
  leadFeeds: true,
};

/** What a stage switches on when a city enters it; the body may override any. */
export const DEFAULT_SWITCHES: Readonly<Record<CityStageValue, Readonly<CitySwitches>>> = {
  PLANNED: ALL_OFF,
  SEEDING: { ...ALL_OFF, supplyIntake: true, agentOnboarding: true, leadFeeds: true },
  LAUNCHED: ALL_ON,
  // "All off except existing runs" — the runs are `orders` and `campaigns`
  // rows that already exist, which no switch here touches.
  PAUSED: ALL_OFF,
  WITHDRAWN: ALL_OFF,
};

/** `City.isActive`, kept as a mirror of the stage for its thirty-odd readers. */
export const mirrorOf = (stage: CityStageValue): boolean =>
  stage === 'SEEDING' || stage === 'LAUNCHED' || stage === 'PAUSED';

export const canMove = (from: CityStageValue, to: CityStageValue): boolean =>
  STAGE_TRANSITIONS[from].includes(to);

export type RolloutState = {
  stage: CityStageValue;
  switches: CitySwitches;
  launchedAt: Date | null;
  pausedAt: Date | null;
  withdrawnAt: Date | null;
};

export type RolloutInput = {
  stage?: CityStageValue | undefined;
  switches?: Partial<CitySwitches> | undefined;
};

export type RolloutPlan = RolloutState & {
  isActive: boolean;
  /** Whether anything at all moved — a no-op patch writes no event. */
  changed: boolean;
  /** The functions whose switch moved, for the event and the audit row. */
  flipped: CityFunction[];
};

/**
 * Where a city ends up after a rollout patch.
 *
 * A stage is entered by the table above or refused (409, naming the moves
 * the current stage allows); entering a stage starts from that stage's
 * default switches, then the body's overrides land on top. A patch that
 * names the current stage, or no stage, keeps the switches as they are and
 * applies only the overrides — so ops can open one function on a paused
 * city without re-entering the stage. The three timestamps are stamped on
 * entry and the two "out" ones cleared on leaving; `launchedAt` is kept
 * across a pause because the question it answers is "when did we open".
 */
export function planRollout(current: RolloutState, input: RolloutInput, now = new Date()): RolloutPlan {
  const entering = input.stage !== undefined && input.stage !== current.stage;
  const stage = input.stage ?? current.stage;
  if (entering && !canMove(current.stage, stage)) {
    throw new ApiError(
      409,
      'CONFLICT',
      `A ${current.stage.toLowerCase()} city cannot go ${stage.toLowerCase()}; it can go ${STAGE_TRANSITIONS[current.stage].map((s) => s.toLowerCase()).join(' or ')}.`,
      { from: current.stage, to: stage, allowed: STAGE_TRANSITIONS[current.stage] },
    );
  }
  const base: CitySwitches = entering ? { ...DEFAULT_SWITCHES[stage] } : { ...current.switches };
  const switches: CitySwitches = { ...base };
  for (const fn of CITY_FUNCTIONS) {
    const override = input.switches?.[fn];
    if (override !== undefined) switches[fn] = override;
  }
  const flipped = CITY_FUNCTIONS.filter((fn) => switches[fn] !== current.switches[fn]);

  return {
    stage,
    switches,
    isActive: mirrorOf(stage),
    launchedAt: entering && stage === 'LAUNCHED' ? now : current.launchedAt,
    pausedAt: entering ? (stage === 'PAUSED' ? now : null) : current.pausedAt,
    withdrawnAt: entering ? (stage === 'WITHDRAWN' ? now : null) : current.withdrawnAt,
    changed: entering || flipped.length > 0,
    flipped,
  };
}
