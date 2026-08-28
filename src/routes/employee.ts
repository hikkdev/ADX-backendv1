import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../shared/errors';
import {
  createEmployeeHandler,
  getAllEmployeesHandler,
  getEmployeeByUserIdHandler,
  updateEmployeeHandler,
  deleteEmployeeHandler,
} from '../controllers/employee';
import { asyncHandler } from '../shared/http';
import { authenticate, requireRole } from '../shared/auth';

export const employeeRouter = Router();
employeeRouter.use(authenticate);

// Allow a user to manage their own employee record, or an ADMIN to manage anyone's
function selfOrAdmin(req: Request, _res: Response, next: NextFunction): void {
  const targetUserId = req.params['userId'];
  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');
  if (isAdmin || req.user?.sub === targetUserId) return next();
  throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions');
}

employeeRouter.post('/', requireRole('ADMIN'), asyncHandler(createEmployeeHandler));
employeeRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllEmployeesHandler));
employeeRouter.get('/:userId', selfOrAdmin, asyncHandler(getEmployeeByUserIdHandler));
employeeRouter.put('/:userId', selfOrAdmin, asyncHandler(updateEmployeeHandler));
employeeRouter.delete('/:userId', requireRole('ADMIN'), asyncHandler(deleteEmployeeHandler));
