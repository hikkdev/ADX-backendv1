/**
 * DR 06 — field visits: the trips that are not a step on an order.
 *
 * `visitsToday` feeds the agent's day view in `agents`; `expireVisitOffers` is
 * the 25-minute sweep for `jobs/agent-timer`; `createVisit` is how a lead
 * becomes a visit. Everything else is reached over HTTP.
 */
export { visitRouter, agentDayRouter } from './visits.routes';
export { createVisit, expireVisitOffers, visitsToday } from './visits.service';
/** Used by `suspension`: Lot A STOP_OPEN_WORK takes an agent's open visits off them. */
export { cancelAgentVisits } from './visits.service';
/** Used by `account-lifecycle`: the same visits, counted rather than cancelled, for Lot A's closure review. */
export { countOpenVisitsForAgent } from './visits.service';
/** P-B: the visits made to one publisher, newest first — `publishers`' detail card reads its feed through this, never the table. */
export { visitsForPublisher } from './visits.service';
/**
 * Lot B (Q1): `packages` and `campaigns` ask this before accepting a
 * `visitId` on a sale or a draft — the agent's own visit, in progress or
 * completed today. The outcome itself is counted here, off their rows.
 */
export { assertVisitOutcome, outcomesFor, outcomeSummary } from './visits.service';
export type { VisitOutcomes } from './visits.service';
export type { VisitCard } from './visits.service';
export type { AgentDay, DayEntry } from './day.service';
/** Lot E (Q99): the day's fold over a date range, for `schedule`'s read-only overlay on an agent's diary. */
export { agentWorkInWindow } from './day.service';
export type { OverlayEntry } from './day.service';
export { VISIT_OFFER_MINUTES, VISIT_KINDS, visitPillOf, visitKindLabel } from './visits.schema';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
