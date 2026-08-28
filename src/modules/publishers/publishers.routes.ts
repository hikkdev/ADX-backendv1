import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  createPublisherHandler, getPublishersHandler, getPublisherHandler, updatePublisherHandler,
  submitKycHandler, reviewKycHandler, getOnboardingStatusHandler, getPublisherListingsHandler,
} from './publishers.controller';
import {
  registerPublisherProfileHandler, getMyPublisherProfileHandler, getMyOnboardingQrHandler,
  cancelMyOnboardingHandler, cancelOnboardingHandler, completeOnboardingHandler,
} from './onboarding/publisher-onboarding.controller';
import { initiateDigioKycHandler, getDigioKycStatusHandler } from './kyc/digio.controller';

export const publisherRouter = Router();
publisherRouter.use(authenticate);

// ── Publisher self-service (PUBLISHER role, user app) ──
// These literal paths must stay ahead of the /:publisherId routes below.
publisherRouter.post('/register', requireRole('PUBLISHER'), asyncHandler(registerPublisherProfileHandler));
publisherRouter.get('/me', requireRole('PUBLISHER'), asyncHandler(getMyPublisherProfileHandler));
publisherRouter.get('/me/qr', requireRole('PUBLISHER'), asyncHandler(getMyOnboardingQrHandler));
publisherRouter.post('/me/cancel-onboarding', requireRole('PUBLISHER'), asyncHandler(cancelMyOnboardingHandler));

// ── Agent / admin publisher management ──
publisherRouter.get('/', asyncHandler(getPublishersHandler));
publisherRouter.post('/', requireRole('AGENT_PUBLISHER'), asyncHandler(createPublisherHandler));
publisherRouter.get('/:publisherId', asyncHandler(getPublisherHandler));
publisherRouter.patch('/:publisherId', requireRole('AGENT_PUBLISHER'), asyncHandler(updatePublisherHandler));
publisherRouter.post('/:publisherId/kyc', requireRole('AGENT_PUBLISHER'), asyncHandler(submitKycHandler));
publisherRouter.post('/:publisherId/kyc/review', requireRole('ADMIN'), asyncHandler(reviewKycHandler));
publisherRouter.post('/:publisherId/kyc/digio/initiate', requireRole('AGENT_PUBLISHER'), asyncHandler(initiateDigioKycHandler));
publisherRouter.get('/:publisherId/kyc/digio/status', asyncHandler(getDigioKycStatusHandler));
publisherRouter.get('/:publisherId/onboarding-status', asyncHandler(getOnboardingStatusHandler));
publisherRouter.post('/:publisherId/cancel-onboarding', requireRole('AGENT_PUBLISHER', 'ADMIN'), asyncHandler(cancelOnboardingHandler));
publisherRouter.post('/:publisherId/complete-onboarding', requireRole('AGENT_PUBLISHER', 'ADMIN'), asyncHandler(completeOnboardingHandler));
publisherRouter.get('/:publisherId/listings', asyncHandler(getPublisherListingsHandler));
