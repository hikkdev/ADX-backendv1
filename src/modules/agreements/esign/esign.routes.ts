import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requireRole } from '../../../shared/auth';
import {
  getSigningHandler,
  listSigningHandler,
  mockSignHandler,
  mySigningHandler,
  openSigningHandler,
  refreshSigningHandler,
  remindSigningHandler,
  voidSigningHandler,
} from './esign.controller';

/**
 * DS-1: `/agreements/signing`. The party's own doors first — `/mine`, a
 * request by id, its refresh, the mock signature — for any signed-in person
 * who belongs to the request's party (checked in the handler); then the
 * desk's list, send, remind and void under ADMIN. Mounted by
 * `agreements.routes` ahead of its own ADMIN guard.
 */
export const signingRouter = Router();
signingRouter.use(authenticate);

signingRouter.get('/mine', asyncHandler(mySigningHandler));
signingRouter.get('/:id', asyncHandler(getSigningHandler));
signingRouter.post('/:id/refresh', asyncHandler(refreshSigningHandler));
signingRouter.post('/:id/mock-sign', asyncHandler(mockSignHandler));

signingRouter.use(requireRole('ADMIN'));
signingRouter.get('/', asyncHandler(listSigningHandler));
signingRouter.post('/', asyncHandler(openSigningHandler));
signingRouter.post('/:id/remind', asyncHandler(remindSigningHandler));
signingRouter.post('/:id/void', asyncHandler(voidSigningHandler));
