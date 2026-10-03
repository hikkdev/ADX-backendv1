import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
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

onboardingRouter.get('/flow-templates', requirePermission('settings.view'), asyncHandler(listFlowTemplates));
onboardingRouter.get('/flow-templates/:key', requirePermission('settings.view'), asyncHandler(getFlowTemplate));
onboardingRouter.put('/flow-templates/:key', requirePermission('flows.edit'), asyncHandler(upsertFlowTemplate));

onboardingRouter.get('/submissions', requirePermission('marketplace.view'), asyncHandler(listOnboardingSubmissions));
onboardingRouter.post('/submissions', requirePermission('marketplace.edit'), asyncHandler(createOnboardingSubmission));
onboardingRouter.get('/submissions/:id', requirePermission('marketplace.view'), asyncHandler(getOnboardingSubmission));
onboardingRouter.patch('/submissions/:id', requirePermission('marketplace.edit'), asyncHandler(updateOnboardingSubmission));
onboardingRouter.delete('/submissions/:id', requirePermission('marketplace.delete'), asyncHandler(deleteOnboardingSubmission));
onboardingRouter.patch('/submissions/:id/status', requirePermission('marketplace.edit'), asyncHandler(updateOnboardingSubmissionStatus));
