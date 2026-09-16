/**
 * An agent's rating — DR 07's "My rating" (Figma 4434:410), decision 3.
 *
 * **Derived from rows that already exist, not from a feed somebody has to
 * remember to write.** Three drivers, each a plain ratio over a window:
 *
 *   - **Completion rate** — of the jobs they accepted, how many reached a
 *     completed status.
 *   - **On-time arrival** — of the jobs with a confirmed slot and a check-in,
 *     how many were checked into within the grace period.
 *   - **Rejection rate** — the same thirty-day decline rate
 *     `shared/dispatch/offer-priority.ts` already computes for the sweep. The
 *     rating is built on that file rather than beside it, so an agent cannot
 *     be told one thing by their rating screen and another by the dispatcher.
 *
 * The score is those three weighted onto five stars, and the ledger the frame
 * calls "What changed recently" is the same rows read back in time order —
 * a real completion, a real rejection — rather than a synthetic event stream.
 *
 * Nothing here reads the database. The service feeds it rows; this decides.
 */

export const RATING_WINDOW_DAYS = 90;
/** Minutes after the confirmed slot that still counts as on time. */
export const ON_TIME_GRACE_MINUTES = 15;
/** Below this many finished jobs there is no rating worth printing. */
export const MIN_JOBS_FOR_A_RATING = 5;
/** Where an agent starts, and where one with too little history stays. */
export const BASE_SCORE = 4.0;

/**
 * Lot D (Q19/Q112): the fourth driver is the publishers' stars — the one
 * driver a person writes rather than the platform derives. Weighted at 0.2
 * and re-weighted away while the agent has no review at all.
 */
export type DriverKey = 'completion' | 'onTime' | 'rejection' | 'review';

export type Driver = {
  key: DriverKey;
  label: string;
  /** 0–1, or null when there is not enough to judge. */
  rate: number | null;
  /** What the rate is out of, so the screen can say "of 12 jobs". */
  sample: number;
  /** True when a lower number is the better one. */
  inverted: boolean;
};

export type RatingInput = {
  /** Assignments the agent accepted inside the window. */
  accepted: number;
  /** Of those, the ones that reached a completed status. */
  completed: number;
  /** Jobs with both a confirmed slot and a check-in. */
  arrivalsJudged: number;
  /** Of those, the ones inside the grace period. */
  arrivalsOnTime: number;
  /** From offer-priority: offers in the window, and how many were declined. */
  offered: number;
  declined: number;
  /**
   * Lot D (Q112): the publishers' stars, averaged over every published
   * review of this agent (1–5), and how many there are. Optional so the three
   * derived drivers can still be scored on their own.
   */
  reviewAvg?: number | null;
  reviewCount?: number;
};

export type Rating = {
  /** 0–5, one decimal, or null when there is too little history. */
  score: number | null;
  drivers: Driver[];
  /** How many finished jobs the score is based on. */
  sample: number;
  /** True while the agent has too little history for a score. */
  provisional: boolean;
};

const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

/** Whether a check-in beat the slot, with the grace period the field needs. */
export function arrivedOnTime(slotTime: Date, checkedInAt: Date, graceMinutes = ON_TIME_GRACE_MINUTES): boolean {
  return checkedInAt.getTime() <= slotTime.getTime() + graceMinutes * 60_000;
}

/**
 * Stars onto the 0–1 goodness the other drivers speak.
 *
 * Four stars is neutral — the goodness the base score anchors on (0.85) —
 * so a run of fours neither lifts nor drags the score, which is what the
 * ledger says a four is worth (nothing). Five is a full 1; below four the
 * line falls to 0 at one star.
 */
export function reviewGoodness(avg: number): number {
  const stars = Math.min(5, Math.max(1, avg));
  return stars >= 4 ? 0.85 + (stars - 4) * 0.15 : ((stars - 1) / 3) * 0.85;
}

export function driversOf(input: RatingInput): Driver[] {
  const reviewCount = input.reviewCount ?? 0;
  const reviewAvg = input.reviewAvg ?? null;
  return [
    { key: 'completion', label: 'Completion rate', rate: ratio(input.completed, input.accepted), sample: input.accepted, inverted: false },
    { key: 'onTime', label: 'On-time arrival', rate: ratio(input.arrivalsOnTime, input.arrivalsJudged), sample: input.arrivalsJudged, inverted: false },
    { key: 'rejection', label: 'Rejection rate', rate: ratio(input.declined, input.offered), sample: input.offered, inverted: true },
    {
      key: 'review',
      label: 'Publisher rating',
      rate: reviewCount > 0 && reviewAvg !== null ? reviewGoodness(reviewAvg) : null,
      sample: reviewCount,
      inverted: false,
    },
  ];
}

/**
 * The four drivers onto five stars.
 *
 * Completion carries the most weight — finishing what you took on is the
 * whole job — with arrival, rejection and the publishers' stars a fifth
 * each (Lot D, Q112: 0.4 / 0.2 / 0.2 / 0.2). A driver with no sample is left
 * out and the rest are re-weighted, so an agent with no scheduled visits is
 * not marked down for having none, and one nobody has rated yet is scored on
 * the three derived drivers in their old 0.5 / 0.25 / 0.25 proportions.
 */
export const WEIGHTS: Record<DriverKey, number> = { completion: 0.4, onTime: 0.2, rejection: 0.2, review: 0.2 };

export function scoreOf(input: RatingInput): Rating {
  const drivers = driversOf(input);
  const finished = input.completed + Math.max(0, input.accepted - input.completed);
  const provisional = finished < MIN_JOBS_FOR_A_RATING;

  const judged = drivers.filter((driver) => driver.rate !== null);
  if (provisional || judged.length === 0) {
    return { score: null, drivers, sample: finished, provisional: true };
  }

  const weight = judged.reduce((total, driver) => total + WEIGHTS[driver.key], 0);
  const goodness = judged.reduce((total, driver) => {
    const good = driver.inverted ? 1 - (driver.rate as number) : (driver.rate as number);
    return total + good * WEIGHTS[driver.key];
  }, 0);

  // Anchored on the base so an agent with a thin but clean record is not
  // handed five stars, and rounded the way the frame prints it.
  const raw = BASE_SCORE + (goodness / weight - 0.85) * 6.5;
  const score = Math.round(Math.min(5, Math.max(1, raw)) * 10) / 10;
  return { score, drivers, sample: finished, provisional: false };
}

export type LedgerEntry = {
  id: string;
  /** completion · rejection · arrival · review */
  kind: 'completion' | 'rejection' | 'arrival' | 'review';
  title: string;
  detail: string | null;
  at: Date;
  /** What it did to the score, to one decimal. Positive helps. */
  delta: number;
  /** E7-2, review rows: the publisher who rated, by name; null when unknown. */
  by?: string | null;
};

/**
 * What a completed job, a late arrival and a rejection are each worth — and
 * (Lot D, Q112) a publisher's stars: five is +0.1, four is nothing, three or
 * fewer is −0.1.
 */
export const DELTA = { completion: 0.1, lateArrival: -0.1, rejection: -0.2, fiveStars: 0.1, fourStars: 0, threeStarsOrLess: -0.1 } as const;

/** The ledger delta a rating is worth. */
export function reviewDelta(rating: number): number {
  return rating >= 5 ? DELTA.fiveStars : rating === 4 ? DELTA.fourStars : DELTA.threeStarsOrLess;
}

/**
 * "What changed recently" — the same rows, read back newest first.
 *
 * Every entry names something that actually happened to a real order, so an
 * agent can check the claim. The deltas are what each event is worth to the
 * score; they are the rule, not a stored number, so the ledger and the score
 * can never disagree.
 */
export function ledgerOf(events: {
  completions: { orderId: string; at: Date; campaignName: string | null; onTime: boolean | null }[];
  rejections: { orderId: string; at: Date; reason: string | null }[];
  /** Lot D (Q112): a publisher's stars, from the reviews module through its port. */
  reviews?: { reviewId: string; at: Date; rating: number; note: string | null; publisherName?: string | null }[];
}): LedgerEntry[] {
  const entries: LedgerEntry[] = [
    ...(events.reviews ?? []).map((event) => ({
      id: `review:${event.reviewId}`,
      kind: 'review' as const,
      // E7-2: the row names who rated when the port says; "Publisher" otherwise.
      title: `${event.publisherName ?? 'Publisher'} rated you ${event.rating} star${event.rating === 1 ? '' : 's'}`,
      detail: event.note,
      at: event.at,
      delta: reviewDelta(event.rating),
      by: event.publisherName ?? null,
    })),
    ...events.completions.map((event) => ({
      id: `completion:${event.orderId}`,
      kind: (event.onTime === false ? 'arrival' : 'completion') as LedgerEntry['kind'],
      title: event.onTime === false ? 'Late arrival' : 'On-time installation',
      detail: event.campaignName,
      at: event.at,
      delta: event.onTime === false ? DELTA.lateArrival : DELTA.completion,
    })),
    ...events.rejections.map((event) => ({
      id: `rejection:${event.orderId}`,
      kind: 'rejection' as const,
      title: 'Order rejected',
      detail: event.reason ? event.reason.toLowerCase().replace(/_/g, ' ') : null,
      at: event.at,
      delta: DELTA.rejection,
    })),
  ];
  entries.sort((a, b) => b.at.getTime() - a.at.getTime());
  return entries;
}

/**
 * "Top 15% of agents in Bengaluru" — real or not printed at all.
 *
 * Needs a cohort: at least this many rated agents in the same city, or the
 * line is left out rather than computed from four people.
 */
export const MIN_COHORT = 10;

export function percentileOf(score: number | null, cohortScores: number[]): number | null {
  if (score === null || cohortScores.length < MIN_COHORT) return null;
  const better = cohortScores.filter((other) => other > score).length;
  // "Top N%": the share of the cohort scoring above this agent, rounded up to
  // a whole percent so the claim is never rounded in the agent's favour.
  return Math.max(1, Math.ceil((better / cohortScores.length) * 100));
}

/** The sentence under the stars, or nothing when the platform cannot say it. */
export function percentileLabel(percentile: number | null, city: string | null): string | null {
  if (percentile === null || !city) return null;
  return `Top ${percentile}% of agents in ${city}`;
}
