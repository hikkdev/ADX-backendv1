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
