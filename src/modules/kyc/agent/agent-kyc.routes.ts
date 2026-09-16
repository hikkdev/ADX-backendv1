import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../../shared/auth';
import {
  getAgentKycHandler,
  getMyAgentKycHandler,
  listAgentKycsHandler,
  recordAgentKycHandler,
  requestAgentKycHandler,
  reviewAgentKycHandler,
} from './agent-kyc.controller';

export const agentKycRouter = Router();
agentKycRouter.use(authenticate);

// The agent's own record, read-only. Ahead of /:agentId so "me" is never an id.
agentKycRouter.get('/me', asyncHandler(getMyAgentKycHandler));

// Ops: the queue, one record, recording on the agent's behalf, the decision.
agentKycRouter.get('/', requireRole('ADMIN'), asyncHandler(listAgentKycsHandler));
agentKycRouter.get('/:agentId', requireRole('ADMIN'), asyncHandler(getAgentKycHandler));
agentKycRouter.put('/:agentId', requireRole('ADMIN'), asyncHandler(recordAgentKycHandler));
agentKycRouter.patch('/:agentId/review', requireRole('ADMIN'), asyncHandler(reviewAgentKycHandler));
// N3-B: the one-click Digio request — the catalogue's KYC edit tier beside ADMIN (a role config granted
// `kyc.edit` may send it; the super admin and an admin with no role config pass under the launch rule).
agentKycRouter.post('/:agentId/request', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(requestAgentKycHandler));
