import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
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

employeeRouter.post('/', requireRole('ADMIN'), requirePermission('hr.edit'), asyncHandler(createEmployeeHandler));
employeeRouter.get('/', requireRole('ADMIN'), requirePermission('hr.view'), asyncHandler(getAllEmployeesHandler));
// Lot G (Q120/Q139): the workload chart. Literal path, ahead of /:userId.
employeeRouter.get('/workload', requireRole('ADMIN'), requirePermission('hr.view'), asyncHandler(workloadHandler));
// G13-B: the headcount and the open positions. Literal path, ahead of /:userId.
employeeRouter.get('/overview', requireRole('ADMIN'), requirePermission('hr.view'), asyncHandler(overviewHandler));
employeeRouter.get('/:userId', requireRole('ADMIN'), requirePermission('hr.view'), asyncHandler(getEmployeeByUserIdHandler));
employeeRouter.put('/:userId', requireRole('ADMIN'), requirePermission('hr.edit'), asyncHandler(updateEmployeeHandler));
employeeRouter.delete('/:userId', requireRole('ADMIN'), requirePermission('hr.delete'), asyncHandler(deleteEmployeeHandler));
