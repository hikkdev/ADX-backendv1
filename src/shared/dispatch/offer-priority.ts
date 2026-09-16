/**
 * Offer priority — the rule behind DR 07's sentence to agents: "Frequent
 * rejections lower your offer priority. Keep rejections under 10% to stay in
 * the fast lane."
 *
 * One deterministic rule, written down once and read by the sweep and the
 * console alike, so ops can explain any pick. Over the last thirty days:
 *
 *   - an agent with fewer than five offers has no rate worth judging and is
 *     in the fast lane;
 *   - otherwise the share of offers they declined or let expire decides —
 *     at or under 10 % is the fast lane, above it is slowed.
 *
 * The sweep offers to fast-lane agents first, then by that share ascending,
 * then to whoever holds the least work, then by seniority. Nothing here is a
 * rating: no stars, no score out of five — a lane and the number behind it.
 */

export const PRIORITY_WINDOW_DAYS = 30;
export const FAST_LANE_MAX_RATE = 0.1;
export const MIN_OFFERS_FOR_A_RATE = 5;

export type OfferLane = 'FAST' | 'SLOWED';

export type OfferPriority = {
  lane: OfferLane;
  /** Offers in the window. */
  offered: number;
  /** Declined or left to expire, in the window. */
  declined: number;
  /** declined / offered, or null with too few offers to judge. */
  declineRate: number | null;
  windowDays: number;
};

/** A candidate as the repository reads it: the caps and the recent answers. */
export type DispatchCandidate = {
  id: string;
  createdAt: Date;
  maxActiveOrders: number | null;
  activeOrders: number;
  /** Status of every offer inside the window. */
  recentOffers: { status: string }[];
};

export function priorityOf(recentOffers: { status: string }[]): OfferPriority {
  const offered = recentOffers.length;
  const declined = recentOffers.filter((offer) => offer.status === 'REJECTED').length;
  if (offered < MIN_OFFERS_FOR_A_RATE) {
    return { lane: 'FAST', offered, declined, declineRate: null, windowDays: PRIORITY_WINDOW_DAYS };
  }
  const declineRate = declined / offered;
  return {
    lane: declineRate <= FAST_LANE_MAX_RATE ? 'FAST' : 'SLOWED',
    offered,
    declined,
    declineRate,
    windowDays: PRIORITY_WINDOW_DAYS,
  };
}

/** When the window opens, for a sweep run at `now`. */
export function priorityWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - PRIORITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** Under their own cap: the one comparison the query language cannot express. */
export function underCap(candidate: Pick<DispatchCandidate, 'maxActiveOrders' | 'activeOrders'>): boolean {
  return candidate.maxActiveOrders === null || candidate.activeOrders < candidate.maxActiveOrders;
}

/**
 * The order the sweep offers in. Fast lane first; then the lower decline
 * rate; then the lighter load; then the longer-serving agent. Stable, so two
 * equal agents keep the order they were read in.
 */
export function rankCandidates<T extends DispatchCandidate>(candidates: T[]): T[] {
  const scored = candidates.map((candidate, index) => ({ candidate, index, priority: priorityOf(candidate.recentOffers) }));
  scored.sort((a, b) => {
    if (a.priority.lane !== b.priority.lane) return a.priority.lane === 'FAST' ? -1 : 1;
    const rateA = a.priority.declineRate ?? 0;
    const rateB = b.priority.declineRate ?? 0;
    if (rateA !== rateB) return rateA - rateB;
    if (a.candidate.activeOrders !== b.candidate.activeOrders) return a.candidate.activeOrders - b.candidate.activeOrders;
    const byAge = a.candidate.createdAt.getTime() - b.candidate.createdAt.getTime();
    return byAge !== 0 ? byAge : a.index - b.index;
  });
  return scored.map((entry) => entry.candidate);
}

/** The sweep's pick: the first ranked candidate with room for the work. */
export function pickAssignable<T extends DispatchCandidate>(candidates: T[]): T | null {
  return rankCandidates(candidates).find(underCap) ?? null;
}
