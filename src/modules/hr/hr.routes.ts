import { Router } from 'express';
import { authenticate, requireRole } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import {
  createHolidayHandler,
  deleteHolidayHandler,
  listHolidaysHandler,
  listPeopleHandler,
  patchHolidayHandler,
} from './hr.controller';
import {
  createDepartmentHandler,
  deleteDepartmentHandler,
  getDepartmentHandler,
  listDepartmentsHandler,
  patchDepartmentHandler,
} from './departments/departments.controller';

/**
 * HR — Lot E (Q98/Q99). ADMIN at the router: the holiday calendar and the
 * people registry are back-office surfaces, and Q143 leaves nobody else
 * with a reason to read them.
 */
export const hrRouter = Router();
hrRouter.use(authenticate, requireRole('ADMIN'));

hrRouter.get('/holidays', asyncHandler(listHolidaysHandler));
hrRouter.post('/holidays', asyncHandler(createHolidayHandler));
hrRouter.patch('/holidays/:holidayId', asyncHandler(patchHolidayHandler));
hrRouter.delete('/holidays/:holidayId', asyncHandler(deleteHolidayHandler));

hrRouter.get('/people', asyncHandler(listPeopleHandler));

// Lot G (Q122/Q140): the org structure ADX keeps itself.
hrRouter.get('/departments', asyncHandler(listDepartmentsHandler));
hrRouter.post('/departments', asyncHandler(createDepartmentHandler));
hrRouter.get('/departments/:departmentId', asyncHandler(getDepartmentHandler));
hrRouter.patch('/departments/:departmentId', asyncHandler(patchDepartmentHandler));
hrRouter.delete('/departments/:departmentId', asyncHandler(deleteDepartmentHandler));
