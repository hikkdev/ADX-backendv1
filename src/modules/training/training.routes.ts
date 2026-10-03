import { Router } from 'express';

import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import {
  createModuleHandler,
  createTrainingHandler,
  getCertificationHandler,
  getCurriculumHandler,
  getModuleAdminHandler,
  getModuleHandler,
  getQuizHandler,
  getTrainingHandler,
  listCertificationsHandler,
  listModulesHandler,
  patchModuleHandler,
  progressHandler,
  putQuestionsHandler,
  revokeCertificationHandler,
  submitQuizHandler,
} from './training.controller';

export const trainingRouter = Router();
trainingRouter.use(authenticate);

/* The library both apps already read. Unchanged — guarded by a session, no role. */
trainingRouter.get('/', asyncHandler(getTrainingHandler));
trainingRouter.post('/', requireRole('ADMIN'), requirePermission('agents.edit'), asyncHandler(createTrainingHandler));

/* The curriculum, for the signed-in agent. */
trainingRouter.get('/curriculum', asyncHandler(getCurriculumHandler));
trainingRouter.get('/certification', asyncHandler(getCertificationHandler));

/* ADMIN CRUD — the console had no training screen at all. Static paths
 * before the parameterised ones, so "modules" is never read as an id. */
trainingRouter.get('/modules', requireRole('ADMIN'), requirePermission('agents.view'), asyncHandler(listModulesHandler));
trainingRouter.post('/modules', requireRole('ADMIN'), requirePermission('agents.edit'), asyncHandler(createModuleHandler));
trainingRouter.get('/modules/:moduleId/admin', requireRole('ADMIN'), requirePermission('agents.view'), asyncHandler(getModuleAdminHandler));
trainingRouter.patch('/modules/:moduleId', requireRole('ADMIN'), requirePermission('agents.edit'), asyncHandler(patchModuleHandler));
trainingRouter.put('/modules/:moduleId/questions', requireRole('ADMIN'), requirePermission('agents.edit'), asyncHandler(putQuestionsHandler));
trainingRouter.get('/certifications', requireRole('ADMIN'), requirePermission('agents.view'), asyncHandler(listCertificationsHandler));
trainingRouter.post('/certifications/:certificationId/revoke', requireRole('ADMIN'), requirePermission('agents.edit'), asyncHandler(revokeCertificationHandler));

/* One module: the lesson, the progress, the quiz. */
trainingRouter.get('/modules/:moduleId', asyncHandler(getModuleHandler));
trainingRouter.post('/modules/:moduleId/progress', asyncHandler(progressHandler));
trainingRouter.get('/modules/:moduleId/quiz', asyncHandler(getQuizHandler));
trainingRouter.post('/modules/:moduleId/quiz', asyncHandler(submitQuizHandler));
