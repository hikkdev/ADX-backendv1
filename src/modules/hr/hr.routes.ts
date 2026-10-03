import { Router } from 'express';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import {
  createHolidayHandler,
  deleteHolidayHandler,
  holidayCalendarHandler,
  listHolidaysHandler,
  listPeopleHandler,
  patchHolidayHandler,
  syncHolidaysHandler,
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

hrRouter.get('/holidays', requirePermission('hr.view'), asyncHandler(listHolidaysHandler));
// HC-1: the public calendar the page follows — what it is and when it last ran, and "Sync now".
hrRouter.get('/holidays/calendar', requirePermission('hr.view'), asyncHandler(holidayCalendarHandler));
hrRouter.post('/holidays/sync', requirePermission('hr.edit'), asyncHandler(syncHolidaysHandler));
hrRouter.post('/holidays', requirePermission('hr.edit'), asyncHandler(createHolidayHandler));
hrRouter.patch('/holidays/:holidayId', requirePermission('hr.edit'), asyncHandler(patchHolidayHandler));
hrRouter.delete('/holidays/:holidayId', requirePermission('hr.delete'), asyncHandler(deleteHolidayHandler));

hrRouter.get('/people', requirePermission('hr.view'), asyncHandler(listPeopleHandler));

// Lot G (Q122/Q140): the org structure ADX keeps itself.
hrRouter.get('/departments', requirePermission('hr.view'), asyncHandler(listDepartmentsHandler));
hrRouter.post('/departments', requirePermission('hr.edit'), asyncHandler(createDepartmentHandler));
hrRouter.get('/departments/:departmentId', requirePermission('hr.view'), asyncHandler(getDepartmentHandler));
hrRouter.patch('/departments/:departmentId', requirePermission('hr.edit'), asyncHandler(patchDepartmentHandler));
hrRouter.delete('/departments/:departmentId', requirePermission('hr.delete'), asyncHandler(deleteDepartmentHandler));
