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
export { milestoneRouter, trainingRouter } from './milestones/agent-milestones.routes';

/**
 * `requireAgentProfile` is the shared replacement for a lookup-and-404 pair
 * that used to be copy-pasted into twelve handlers across five modules. Every
 * caller now gets the same error message.
 */
export { requireAgentProfile, findAgentProfile } from './agents.service';

export { incrementMilestoneProgress } from './milestones/agent-milestones.service';
