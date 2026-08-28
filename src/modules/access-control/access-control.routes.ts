import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  createRoleConfigHandler,
  getAllRoleConfigsHandler,
  getRoleConfigByIdHandler,
  updateRoleConfigHandler,
  deleteRoleConfigHandler,
} from './access-control.controller';

export const rolesConfigRouter = Router();
rolesConfigRouter.use(authenticate);

// Reads are open to any authenticated user (the admin UI renders role pickers
// from them); writes are ADMIN-only.
rolesConfigRouter.post('/', requireRole('ADMIN'), asyncHandler(createRoleConfigHandler));
rolesConfigRouter.get('/', asyncHandler(getAllRoleConfigsHandler));
rolesConfigRouter.get('/:id', asyncHandler(getRoleConfigByIdHandler));
rolesConfigRouter.put('/:id', requireRole('ADMIN'), asyncHandler(updateRoleConfigHandler));
rolesConfigRouter.delete('/:id', requireRole('ADMIN'), asyncHandler(deleteRoleConfigHandler));
