import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { descriptionQuotaHandler, generateDescriptionHandler } from './ai.controller';

export const aiRouter = Router();
aiRouter.use(authenticate);

/*
 * Publishers draft their own descriptions; an agent sitting beside one drafts
 * it on the same account through the delegated-access grant, which is why the
 * guard names the publisher roles rather than the agent's. ADMIN is not here:
 * nobody at ADX writes a publisher's words for them.
 */
aiRouter.use(requireRole('PUBLISHER', 'AGENT_PUBLISHER'));

aiRouter.post('/listing-description', asyncHandler(generateDescriptionHandler));
aiRouter.get('/listing-description/quota', asyncHandler(descriptionQuotaHandler));
