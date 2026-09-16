import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
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
desk.get('/', asyncHandler(listHandler));
desk.post('/', asyncHandler(createHandler));
desk.get('/:id', asyncHandler(getHandler));
desk.patch('/:id', asyncHandler(updateHandler));
desk.delete('/:id', asyncHandler(deleteHandler));
desk.post('/:id/activate', asyncHandler(activateHandler));
legalRouter.use('/documents', desk);

legalRouter.get('/:kind', asyncHandler(currentHandler));
