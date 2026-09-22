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
  acceptAgreementAtDeskHandler,
  acceptMyAgreementHandler,
  applyHandler,
  decideApplicationHandler,
  exitAgentHandler,
  documentExpirySweepHandler,
  getRoutingSettingsHandler,
  saveRoutingSettingsHandler,
  listFleetPartnersHandler,
  getFleetPartnerHandler,
  createFleetPartnerHandler,
  updateFleetPartnerHandler,
  inviteFleetHandler,
  recordInterviewOutcomeHandler,
  scheduleInterviewHandler,
  screenAtDeskHandler,
  verifyVehicleRcHandler,
  fileDocumentAtDeskHandler,
  fileMyDocumentHandler,
  getApplicationHandler,
  getMyApplicationHandler,
  listApplicationsHandler,
  removeMyDocumentHandler,
  reviewDocumentHandler,
  setGradeHandler,
  submitAtDeskHandler,
  submitMyApplicationHandler,
  updateMyApplicationProfileHandler,
  updateProfileAtDeskHandler,
  withdrawMyApplicationHandler,
} from './application/application.controller';
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

// AG-1 (20 Sep 2026): the application. A signed-in person applies (`/apply`,
// any session), then fills, files, accepts and submits under `/me/application`.
// Guarded by the profile lookup, like the rest of `/me`. Declared before `/:id`.
agentRouter.post('/apply', asyncHandler(applyHandler));
agentRouter.get('/me/application', asyncHandler(getMyApplicationHandler));
agentRouter.patch('/me/application/profile', asyncHandler(updateMyApplicationProfileHandler));
agentRouter.put('/me/application/documents/:kind', asyncHandler(fileMyDocumentHandler));
agentRouter.delete('/me/application/documents/:kind', asyncHandler(removeMyDocumentHandler));
agentRouter.post('/me/application/agreement', asyncHandler(acceptMyAgreementHandler));
agentRouter.post('/me/application/submit', asyncHandler(submitMyApplicationHandler));
agentRouter.post('/me/application/withdraw', asyncHandler(withdrawMyApplicationHandler));
// The desk's queue — before `/:id` so "applications" is never read as an id.
agentRouter.get('/applications', requireRole('ADMIN'), asyncHandler(listApplicationsHandler));
// AG-4: the paper-expiry sweep, run by hand (the job runs it every six hours).
agentRouter.post('/applications/expiry-sweep', requireRole('ADMIN'), asyncHandler(documentExpirySweepHandler));
// AG-5: routing by grade — the bands-to-grades settings; fleet partners and their invites. Before `/:id`.
agentRouter.get('/routing-settings', requireRole('ADMIN'), asyncHandler(getRoutingSettingsHandler));
agentRouter.put('/routing-settings', requireRole('ADMIN'), asyncHandler(saveRoutingSettingsHandler));
agentRouter.get('/fleet-partners', requireRole('ADMIN'), asyncHandler(listFleetPartnersHandler));
agentRouter.post('/fleet-partners', requireRole('ADMIN'), asyncHandler(createFleetPartnerHandler));
agentRouter.get('/fleet-partners/:partnerId', requireRole('ADMIN'), asyncHandler(getFleetPartnerHandler));
agentRouter.patch('/fleet-partners/:partnerId', requireRole('ADMIN'), asyncHandler(updateFleetPartnerHandler));
agentRouter.post('/fleet-partners/:partnerId/invites', requireRole('ADMIN'), asyncHandler(inviteFleetHandler));

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
// AG-1: the desk's side of the application — the record, a paper filed for
// them, each paper's decision, the decision itself, the grade, the exit.
agentRouter.get('/:id/application', requireRole('ADMIN'), asyncHandler(getApplicationHandler));
agentRouter.put('/:id/application/documents/:kind', requireRole('ADMIN'), asyncHandler(fileDocumentAtDeskHandler));
// AG-3: the desk runs the same ladder for a person in front of it.
agentRouter.patch('/:id/application/profile', requireRole('ADMIN'), asyncHandler(updateProfileAtDeskHandler));
agentRouter.post('/:id/application/agreement', requireRole('ADMIN'), asyncHandler(acceptAgreementAtDeskHandler));
agentRouter.post('/:id/application/submit', requireRole('ADMIN'), asyncHandler(submitAtDeskHandler));
agentRouter.patch('/:id/application/documents/:kind/review', requireRole('ADMIN'), asyncHandler(reviewDocumentHandler));
agentRouter.post('/:id/application/decision', requireRole('ADMIN'), asyncHandler(decideApplicationHandler));
// AG-4: screening — the interviews the desk books and decides, its own tick, and Cashfree's vehicle-RC check.
agentRouter.post('/:id/application/interviews', requireRole('ADMIN'), asyncHandler(scheduleInterviewHandler));
agentRouter.patch('/:id/application/interviews/:interviewId', requireRole('ADMIN'), asyncHandler(recordInterviewOutcomeHandler));
agentRouter.post('/:id/application/screen', requireRole('ADMIN'), asyncHandler(screenAtDeskHandler));
agentRouter.post('/:id/application/documents/VEHICLE_RC/verify', requireRole('ADMIN'), asyncHandler(verifyVehicleRcHandler));
agentRouter.patch('/:id/grade', requireRole('ADMIN'), asyncHandler(setGradeHandler));
agentRouter.post('/:id/exit', requireRole('ADMIN'), asyncHandler(exitAgentHandler));

// The desk's create. Before AG-1 this was the only way an agent came to exist;
// it still makes a working (ACTIVE) agent in one step for the desk that met
// the person and saw their papers, and with `asApplication: true` it starts
// an application at PROFILE instead — the same ladder the app climbs.
agentRouter.post('/', requireRole('ADMIN'), asyncHandler(createAgentHandler));
