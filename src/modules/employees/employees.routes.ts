import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  createEmployeeHandler,
  getAllEmployeesHandler,
  getEmployeeByUserIdHandler,
  updateEmployeeHandler,
  deleteEmployeeHandler,
  overviewHandler,
  workloadHandler,
} from './employees.controller';

/**
 * ADMIN on every route (Q143): an employee without a console role cannot
 * sign in, so there is nobody to serve a self-service read or edit to. The
 * per-route guard is kept, rather than one on the router, so the inventory
 * keeps recording each route's chain as it always has.
 */
export const employeeRouter = Router();
employeeRouter.use(authenticate);

employeeRouter.post('/', requireRole('ADMIN'), asyncHandler(createEmployeeHandler));
employeeRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllEmployeesHandler));
// Lot G (Q120/Q139): the workload chart. Literal path, ahead of /:userId.
employeeRouter.get('/workload', requireRole('ADMIN'), asyncHandler(workloadHandler));
// G13-B: the headcount and the open positions. Literal path, ahead of /:userId.
employeeRouter.get('/overview', requireRole('ADMIN'), asyncHandler(overviewHandler));
employeeRouter.get('/:userId', requireRole('ADMIN'), asyncHandler(getEmployeeByUserIdHandler));
employeeRouter.put('/:userId', requireRole('ADMIN'), asyncHandler(updateEmployeeHandler));
employeeRouter.delete('/:userId', requireRole('ADMIN'), asyncHandler(deleteEmployeeHandler));
