/**
 * Dispatch rules that more than one module reads.
 *
 * The offer-priority rule is the agents module's sweep order and the orders
 * module's history line at once; a pure rule with two readers lives here so
 * neither module reaches into the other.
 */
export {
  FAST_LANE_MAX_RATE,
  MIN_OFFERS_FOR_A_RATE,
  PRIORITY_WINDOW_DAYS,
  pickAssignable,
  priorityOf,
  priorityWindowStart,
  rankCandidates,
  underCap,
} from './offer-priority';
export type { DispatchCandidate, OfferLane, OfferPriority } from './offer-priority';
