import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  createAgentHandler,
  getAllAgentsHandler,
  getAgentByIdHandler,
  getAgentRatingHandler,
  getMyDashboardHandler,
  getMyRatingHandler,
  getMyPreferencesHandler,
  updateAgentHandler,
  updateMyPreferencesHandler,
} from './agents.controller';
import { getAgentMilestonesHandler } from './milestones/agent-milestones.controller';
import {
  acknowledgeTierHandler,
  getAgentTierHandler,
  getCityLeaderboardHandler,
  getLadderHandler,
  getMyLeaderboardHandler,
  getMyTierHandler,
  pinTierHandler,
  putLadderHandler,
} from './tier/tier.controller';

export const agentRouter = Router();
agentRouter.use(authenticate);

// The agent's own dashboard. Declared before `/:id` so "me" is never read as
// an id — and guarded by the profile lookup rather than a role, the same way
// the milestone board is: a signed-in user without a profile gets a 404.
agentRouter.get('/me', asyncHandler(getMyDashboardHandler));
// D5: the agent's own DR 07 work preferences — the subset they may set themselves.
// DR 07 wave 6: their rating, and the drivers behind it.
agentRouter.get('/me/rating', asyncHandler(getMyRatingHandler));
// DR 05: the ladder the header climbs, the promotion to celebrate once, the board.
agentRouter.get('/me/tier', asyncHandler(getMyTierHandler));
agentRouter.post('/me/tier/ack', asyncHandler(acknowledgeTierHandler));
agentRouter.get('/me/leaderboard', asyncHandler(getMyLeaderboardHandler));
// The thresholds and support lines, from the desk. Declared before '/:id'.
agentRouter.get('/tier-ladder', requireRole('ADMIN'), asyncHandler(getLadderHandler));
agentRouter.put('/tier-ladder', requireRole('ADMIN'), asyncHandler(putLadderHandler));
agentRouter.get('/leaderboard', requireRole('ADMIN'), asyncHandler(getCityLeaderboardHandler));
agentRouter.get('/me/preferences', asyncHandler(getMyPreferencesHandler));
agentRouter.patch('/me/preferences', asyncHandler(updateMyPreferencesHandler));

agentRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllAgentsHandler));
agentRouter.get('/:id', requireRole('ADMIN'), asyncHandler(getAgentByIdHandler));
// D5: the same rating ops read beside the offer lane.
agentRouter.get('/:id/rating', requireRole('ADMIN'), asyncHandler(getAgentRatingHandler));
// DR 05: any agent's milestone board, derived the same way the agent's own is.
agentRouter.get('/:id/milestones', requireRole('ADMIN'), asyncHandler(getAgentMilestonesHandler));
// DR 05: the tier with its history; the explicit door for pinning one, with a reason.
agentRouter.get('/:id/tier', requireRole('ADMIN'), asyncHandler(getAgentTierHandler));
agentRouter.patch('/:id/tier', requireRole('ADMIN'), asyncHandler(pinTierHandler));
// D5: territory, business, preferences and whether they are offered work — from the desk.
agentRouter.patch('/:id', requireRole('ADMIN'), asyncHandler(updateAgentHandler));

// Agents are onboarded in person, at the admin's desk. This is the only way
// one comes to exist — there is deliberately no self-signup route for the role.
agentRouter.post('/', requireRole('ADMIN'), asyncHandler(createAgentHandler));
