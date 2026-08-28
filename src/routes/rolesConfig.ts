import { Router } from 'express';
import {
  createRoleConfigHandler,
  getAllRoleConfigsHandler,
  getRoleConfigByIdHandler,
  updateRoleConfigHandler,
  deleteRoleConfigHandler,
} from '../controllers/rolesConfig';
import { asyncHandler } from '../shared/http';
import { authenticate, requireRole } from '../shared/auth';

export const rolesConfigRouter = Router();
rolesConfigRouter.use(authenticate);

rolesConfigRouter.post('/', requireRole('ADMIN'), asyncHandler(createRoleConfigHandler));
rolesConfigRouter.get('/', asyncHandler(getAllRoleConfigsHandler));
rolesConfigRouter.get('/:id', asyncHandler(getRoleConfigByIdHandler));
rolesConfigRouter.put('/:id', requireRole('ADMIN'), asyncHandler(updateRoleConfigHandler));
rolesConfigRouter.delete('/:id', requireRole('ADMIN'), asyncHandler(deleteRoleConfigHandler));
