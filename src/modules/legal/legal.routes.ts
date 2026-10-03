import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import {
  activateHandler,
  createHandler,
  currentHandler,
  deleteHandler,
  getHandler,
  indexHandler,
  listHandler,
  updateHandler,
} from './legal.controller';

export const legalRouter = Router();

/* The two public reads carry no token on purpose: the sign-in screen's legal
 * line and the About screen are reachable before anyone has one. `/documents`
 * sits above `/:kind` so it is never read as a kind. */
legalRouter.get('/', asyncHandler(indexHandler));

const desk = Router();
desk.use(authenticate, requireRole('ADMIN'));
desk.get('/', requirePermission('content.view'), asyncHandler(listHandler));
desk.post('/', requirePermission('content.edit'), asyncHandler(createHandler));
desk.get('/:id', requirePermission('content.view'), asyncHandler(getHandler));
desk.patch('/:id', requirePermission('content.edit'), asyncHandler(updateHandler));
desk.delete('/:id', requirePermission('content.delete'), asyncHandler(deleteHandler));
desk.post('/:id/activate', requirePermission('content.approve'), asyncHandler(activateHandler));
legalRouter.use('/documents', desk);

legalRouter.get('/:kind', asyncHandler(currentHandler));
