import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { selfOrAdmin } from './employees.policy';
import {
  createEmployeeHandler,
  getAllEmployeesHandler,
  getEmployeeByUserIdHandler,
  updateEmployeeHandler,
  deleteEmployeeHandler,
} from './employees.controller';

export const employeeRouter = Router();
employeeRouter.use(authenticate);

employeeRouter.post('/', requireRole('ADMIN'), asyncHandler(createEmployeeHandler));
employeeRouter.get('/', requireRole('ADMIN'), asyncHandler(getAllEmployeesHandler));
employeeRouter.get('/:userId', selfOrAdmin, asyncHandler(getEmployeeByUserIdHandler));
employeeRouter.put('/:userId', selfOrAdmin, asyncHandler(updateEmployeeHandler));
employeeRouter.delete('/:userId', requireRole('ADMIN'), asyncHandler(deleteEmployeeHandler));
