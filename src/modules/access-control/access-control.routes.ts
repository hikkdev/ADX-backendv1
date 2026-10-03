import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import {
  createRoleConfigHandler,
  getCapabilitiesHandler,
  getAllRoleConfigsHandler,
  getRoleConfigByIdHandler,
  updateRoleConfigHandler,
  deleteRoleConfigHandler,
} from './access-control.controller';

export const rolesConfigRouter = Router();
rolesConfigRouter.use(authenticate);

// Reads are open to any authenticated user (the admin UI renders role pickers
// from them); writes are ADMIN-only.
rolesConfigRouter.post('/', requireRole('ADMIN'), requirePermission('system.roles'), asyncHandler(createRoleConfigHandler));
rolesConfigRouter.get('/', asyncHandler(getAllRoleConfigsHandler));
// Ahead of '/:id', which would otherwise read "capabilities" as an id.
rolesConfigRouter.get('/capabilities', asyncHandler(getCapabilitiesHandler));
rolesConfigRouter.get('/:id', asyncHandler(getRoleConfigByIdHandler));
rolesConfigRouter.put('/:id', requireRole('ADMIN'), requirePermission('system.roles'), asyncHandler(updateRoleConfigHandler));
rolesConfigRouter.delete('/:id', requireRole('ADMIN'), requirePermission('system.roles'), asyncHandler(deleteRoleConfigHandler));
