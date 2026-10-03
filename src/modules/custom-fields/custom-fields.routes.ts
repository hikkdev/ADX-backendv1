import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import {
  archiveDefHandler,
  createDefHandler,
  deskSetValuesHandler,
  deskValuesHandler,
  listDefsHandler,
  ownerDefsHandler,
  ownerSetValuesHandler,
  ownerValuesHandler,
  requireEntityPermission,
  restoreDefHandler,
  updateDefHandler,
} from './custom-fields.controller';

/**
 * `/custom-fields` — the desk. The definitions are Settings › Custom fields
 * (settings.view / settings.edit); a record's values are read and written
 * with the record's own group (supply for a publisher and its listings,
 * demand for an advertiser, marketplace for a lead — `requireEntityPermission`).
 */
export const customFieldRouter = Router();
customFieldRouter.use(authenticate, requireRole('ADMIN'));
// The values first, so `values` is never read as a definition id.
customFieldRouter.get('/values/:entity/:entityId', requireEntityPermission('view'), asyncHandler(deskValuesHandler));
customFieldRouter.put('/values/:entity/:entityId', requireEntityPermission('edit'), asyncHandler(deskSetValuesHandler));
customFieldRouter.get('/', requirePermission('settings.view'), asyncHandler(listDefsHandler));
customFieldRouter.post('/', requirePermission('settings.edit'), asyncHandler(createDefHandler));
customFieldRouter.patch('/:id', requirePermission('settings.edit'), asyncHandler(updateDefHandler));
customFieldRouter.post('/:id/archive', requirePermission('settings.edit'), asyncHandler(archiveDefHandler));
customFieldRouter.post('/:id/restore', requirePermission('settings.edit'), asyncHandler(restoreDefHandler));

/**
 * `/app/custom-fields` — the record's owner, in the apps and on the website.
 * Any signed-in session may read what is shown to owners; a value is read
 * or written only on the caller's own record (`assertOwner`), and only the
 * fields marked `editableByOwner` are theirs to change.
 */
export const appCustomFieldRouter = Router();
appCustomFieldRouter.use(authenticate);
appCustomFieldRouter.get('/values/:entity/:entityId', asyncHandler(ownerValuesHandler));
appCustomFieldRouter.put('/values/:entity/:entityId', asyncHandler(ownerSetValuesHandler));
appCustomFieldRouter.get('/:entity', asyncHandler(ownerDefsHandler));
