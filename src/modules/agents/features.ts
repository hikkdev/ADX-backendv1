import { feature } from '../../shared/features';

/**
 * Features of `agents` — Lot G (answer 144).
 *
 * The field worker: profile, tiers, leaderboard, gamification milestones, work
 * preferences.
 *
 * One key per user-facing capability. Route prefixes cover the module's
 * routes for tests/architecture/feature-registry.test.ts; the longest
 * declared prefix wins, so the root prefix is the safety net.
 */

feature('agent.profile', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Agent profiles: the agent\'s own read and rating, the console directory and edits.',
  routes: ['/api/v1/agents'],
});

feature('agent.tiers', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The tier ladder, an agent\'s tier and the acknowledgement of a move.',
  routes: [
    '/api/v1/agents/me/tier',
    '/api/v1/agents/tier-ladder',
    '/api/v1/agents/:id/tier',
  ],
});

feature('agent.leaderboard', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'The leaderboard, for the agent and for ops.',
  routes: ['/api/v1/agents/me/leaderboard', '/api/v1/agents/leaderboard'],
});

feature('agent.milestones', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'Gamification milestones: templates, targets, rewards and claims.',
  routes: ['/api/v1/milestones', '/api/v1/agents/:id/milestones'],
});

/**
 * CP-1 (23 Sep 2026): what an agent is paid and how much of their work it
 * covers. The salary covers a daily quota of onboardings; past it, an
 * onboarding pays the planned unit cost plus an uplift instead of the flat
 * commission. Effective-dated, audited, and ADMIN-only.
 */
feature('agent.compensation', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "An agent's salary, the daily onboarding quota it covers, and the commission an onboarding past it pays.",
  routes: ['/api/v1/agents/:id/compensation', '/api/v1/agents/:id/standing', '/api/v1/agents/compensation/defaults'],
});

feature('agent.cost-per-onboarding', {
  surfaces: ['CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'What an onboarding cost in agent money — salary committed plus the rewards that buy an account, over the accounts agents actually brought. Read per side and blended, on the three section overviews and on the agent.',
  // The overviews are one route with the section as a parameter, so the prefix is the claim; the per-agent figure rides the standing read.
  routes: ['/api/v1/section-overviews', '/api/v1/agents/:id/standing'],
});

feature('agent.quota-tracker', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    "The day's quota on the milestone board — a tracker, not a milestone: the salary pays it, so there is nothing to claim, and a milestone whose target sits inside the quota is flagged as paid twice.",
  routes: ['/api/v1/milestones', '/api/v1/agents/:id/milestones'],
});

feature('agent.work-preferences', {
  surfaces: ['APP_AGENT'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'What work an agent takes, and where.',
  routes: ['/api/v1/agents/me/preferences'],
});

feature('agent.application', {
  surfaces: ['APP_AGENT', 'CONSOLE'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'AG-1: the agent application — apply in the app, the profile, papers, bank and engagement terms, submission; the desk\'s queue, per-paper review, decision, grade and exit.',
  routes: [
    '/api/v1/agents/apply',
    '/api/v1/agents/me/application',
    '/api/v1/agents/applications',
    '/api/v1/agents/:id/application',
    '/api/v1/agents/:id/grade',
    '/api/v1/agents/:id/exit',
  ],
  // AG-4: screening (the assessment, interviews, the desk's tick), the paper-expiry sweep, and Cashfree's vehicle-RC check.
  // AG-5: the exit's settlement and the purge ninety days on ride the same feature and the same job.
  jobs: ['agent-document-expiry'],
});

feature('agent.routing', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'AG-5: routing by grade — the importance bands on publishers, advertisers and leads mapped to the agent grade they are routed to; dispatch prefers the closest fit at or above it, then the tier, then the nearer agent; the desk may assign over it.',
  routes: ['/api/v1/agents/routing-settings'],
});

feature('agent.fleets', {
  surfaces: ['CONSOLE', 'BACKEND'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description: 'AG-5: fleet partners — the delivery and ride fleets whose riders ADX invites by SMS to apply as field agents, with the partner kept as the provenance on the application.',
  routes: ['/api/v1/agents/fleet-partners', '/api/v1/agents/fleet-partners/:partnerId', '/api/v1/agents/fleet-partners/:partnerId/invites'],
});
