/**
 * Order milestones — the per-order fulfilment checklist an agent works through
 * on site, and the templates and plans it is built from.
 *
 * NOT the same thing as the agent milestone board in `agents`, which is
 * gamification (targets, rewards, tiers) over `AgentMilestone` and
 * `MilestoneTemplate`. Different tables, different routes, different owner.
 *
 *   templates/  OrderMilestoneTemplate — a reusable step with requirements
 *   plans/      MilestonePlan — an ordered set of templates
 *   order/      OrderMilestone — the steps attached to one order
 *   agent/      the agent-facing execution flow and evidence checking
 */
export {
  milestoneTemplateRouter,
  milestonePlanRouter,
  orderMilestoneRouter,
  agentMilestoneRouter,
} from './order-milestones.routes';

/** Used by jobs/agent-timer: A12's 25-minute window on a visit offer, enforced. */
export { expireMilestoneOffers } from './agent/agent-execution.service';

/**
 * The agent's open site visits, for the `visits` module to fold into one list
 * with the field visits it owns. A narrow read rather than a table the other
 * module queries.
 */
export { getAgentMilestones } from './agent/agent-execution.service';

/** Used by `suspension`: Lot A STOP_OPEN_WORK returns a suspended agent's dispatched visits. */
export { releaseAgentMilestones } from './agent/agent-execution.service';

/** Used by `account-lifecycle`: the same milestones, counted, for Lot A's closure review. */
export { countDispatchedMilestones } from './agent/agent-execution.service';

/**
 * Used by `disputes` (Lot D, Q54/Q92): a REINSTALL resolution raises an
 * INSTALLATION visit on the order, and the case reads the visit's status back
 * to say "resolved — re-install pending" until it completes.
 */
export { raiseReinstallMilestone, findMilestoneStatuses } from './order/order-milestones.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
