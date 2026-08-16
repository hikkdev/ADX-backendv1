import { Router } from 'express';
import {
  createOnboardingSubmission,
  deleteOnboardingSubmission,
  getFlowTemplate,
  getOnboardingSubmission,
  listFlowTemplates,
  listOnboardingSubmissions,
  updateOnboardingSubmission,
  updateOnboardingSubmissionStatus,
  upsertFlowTemplate,
} from '../controllers/onboarding';
import { asyncHandler } from '../lib/errors';
import { authenticate, requireRole } from '../middleware/authenticate';

export const onboardingRouter = Router();

onboardingRouter.use(authenticate);
onboardingRouter.use(requireRole('ADMIN'));

onboardingRouter.get('/flow-templates', asyncHandler(listFlowTemplates));
onboardingRouter.get('/flow-templates/:key', asyncHandler(getFlowTemplate));
onboardingRouter.put('/flow-templates/:key', asyncHandler(upsertFlowTemplate));

onboardingRouter.get('/submissions', asyncHandler(listOnboardingSubmissions));
onboardingRouter.post('/submissions', asyncHandler(createOnboardingSubmission));
onboardingRouter.get('/submissions/:id', asyncHandler(getOnboardingSubmission));
onboardingRouter.patch('/submissions/:id', asyncHandler(updateOnboardingSubmission));
onboardingRouter.delete('/submissions/:id', asyncHandler(deleteOnboardingSubmission));
onboardingRouter.patch('/submissions/:id/status', asyncHandler(updateOnboardingSubmissionStatus));
