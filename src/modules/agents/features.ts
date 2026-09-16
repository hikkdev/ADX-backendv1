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

feature('agent.work-preferences', {
  surfaces: ['APP_AGENT'],
  owner: 'agent-experience',
  kind: 'FEATURE',
  launch: 'on',
  description:
    'What work an agent takes, and where.',
  routes: ['/api/v1/agents/me/preferences'],
});
