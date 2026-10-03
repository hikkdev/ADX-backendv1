import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import {
  createHandler,
  currentHandler,
  deleteHandler,
  getHandler,
  indexHandler,
  listHandler,
  publishHandler,
  unpublishHandler,
  updateHandler,
} from './content.controller';

export const contentRouter = Router();

/* The two public reads carry no token on purpose: the website and the help
 * centre are read by people who have never signed in. `/pages` is mounted
 * above `/:slug` so the desk's own prefix is never read as a page, and
 * "pages" is a reserved slug so nothing can be published there either. */
contentRouter.get('/', asyncHandler(indexHandler));

const desk = Router();
desk.use(authenticate, requireRole('ADMIN'));
desk.get('/', requirePermission('content.view'), asyncHandler(listHandler));
desk.post('/', requirePermission('content.edit'), asyncHandler(createHandler));
desk.get('/:id', requirePermission('content.view'), asyncHandler(getHandler));
desk.patch('/:id', requirePermission('content.edit'), asyncHandler(updateHandler));
desk.delete('/:id', requirePermission('content.delete'), asyncHandler(deleteHandler));
desk.post('/:id/publish', requirePermission('content.approve'), asyncHandler(publishHandler));
desk.post('/:id/unpublish', requirePermission('content.approve'), asyncHandler(unpublishHandler));
contentRouter.use('/pages', desk);

contentRouter.get('/:slug', asyncHandler(currentHandler));
