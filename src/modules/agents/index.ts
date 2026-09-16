/**
 * Agents — field workers with an `AgentProfile`, plus their milestone board and
 * training library.
 *
 * Not to be confused with `order-milestones`, which is the per-order fulfilment
 * checklist. These are agent gamification: `AgentMilestone`,
 * `MilestoneTemplate`, `TrainingResource`. Different tables, different routes,
 * different owner.
 *
 * Not to be confused with `employees` either — those are internal staff HR
 * records.
 */
export { agentRouter } from './agents.routes';
export { milestoneRouter } from './milestones/agent-milestones.routes';

/**
 * `requireAgentProfile` is the shared replacement for a lookup-and-404 pair
 * that used to be copy-pasted into twelve handlers across five modules. Every
 * caller now gets the same error message.
 */
export { requireAgentProfile, findAgentProfile } from './agents.service';
/** E7-3: the label per login, for the desks' requester / against-party reads (composed in bootstrap). */
export { findAgentLabelsForUsers } from './agents.service';
/** K-B1: by agent id, for the QR desk (registered on qr's ref-label port by bootstrap). */
export { findAgentLabels } from './agents.service';
export type { AgentLabelRow } from './agents.repository';

/** Directory lookups `orders` needs for assignment and notification. */
export { getAgentWithUser, findAssignableAgent, agentExists, getAgentZone } from './agents.service';

/**
 * Lot B: the tier an incentive is recorded at. `orders` (installation),
 * `publishers` and `advertisers` (onboarding) and `campaigns` (assist) read it
 * by profile id, because the agent being paid is rarely the session.
 */
export { findAgentTier } from './agents.service';

/**
 * Lot A BLOCK_NEW, for every place work is put in front of an agent: the order
 * lane's shortcut, a field visit, an order milestone and a lead. One answer,
 * so a suspension cannot be honoured in four different ways.
 */
export { agentAcceptsWork, assertAgentAcceptsWork } from './agents.service';
/** DR 07 wave 6: the rating, derived from orders, assignments and check-ins. */
export { ratingFor } from './rating/rating.service';

/**
 * Lot D (Q19/Q112): the publishers' stars as the fourth rating driver.
 * `reviews` writes the `AgentRating.reviewAvg / reviewCount` snapshot through
 * `setAgentReviewSnapshot` after every rating, and fills the port bootstrap
 * registers so the ledger can read the recent ones back without a cycle.
 */
export { setAgentReviewSnapshot } from './rating/rating.service';
export { registerAgentReviewPort, resetAgentReviewPort } from './rating/review-feed.port';
export type { AgentReviewPort, AgentReviewEntry } from './rating/review-feed.port';
export type { AgentZone } from './agents.repository';

/** DR 05: the board, derived on read; the dashboard hero reads the active one. */
export type { MilestoneBoard, MilestoneCard, TemplateView } from './milestones/agent-milestones.service';
export { MILESTONE_STATES, MILESTONE_CHIPS } from './milestones/milestone.rules';
export type { MilestoneState, MilestoneChip } from './milestones/milestone.rules';

/** The DR 01 dashboard header's data and the ladder it is computed on. */
export type { AgentDashboard, AgentSide, LeadCluster } from './dashboard.service';
export { LADDER, rungFor, AGENT_TIERS, TIER_LEVELS } from './tier-ladder';
export type { TierView, TierEventView, TierBenefit } from './tier/tier.service';
export type { LeaderboardView } from './leaderboard/leaderboard.service';
/** O-B: the desk's leaderboard read (`GET /agents/leaderboard`), for `section-overviews` to carry the top rows of a city. */
export { getLeaderboardForCity } from './leaderboard/leaderboard.service';
export { LEADERBOARD_PERIODS } from './leaderboard/leaderboard.rules';

/** The dashboard's map bubbles come through here; `leads` implements it and bootstrap wires it. */
export { registerLeadLayerPort } from './lead-layer.port';
export type { LeadLayerPort, LeadClusterScope as LeadLayerScope } from './lead-layer.port';

/**
 * Lot D (Q131): `onboarding` provisions an approved AGENT intake through the
 * same door the direct create screen uses — one way an agent comes into
 * being, whichever screen ops chose.
 */
export { createAgent } from './agents.service';
export type { CreateAgentInput } from './agents.schema';
/** Lot S: `party-imports` fills a matched agent's empty city / state through the console's PATCH door. */
export { updateAgent } from './agents.service';
export type { UpdateAgentInput } from './agents.schema';

/** Lot E (Q99): ACTIVE agents for `hr`'s people registry — the other half is `employees`. */
export { listActiveAgentsForDirectory } from './agents.service';
export type { AgentDirectoryEntry } from './agents.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
