import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
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
} from './onboarding.controller';

export const onboardingRouter = Router();

// The whole module is admin-only: these endpoints provision user accounts.
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
