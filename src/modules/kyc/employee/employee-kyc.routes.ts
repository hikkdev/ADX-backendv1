import { Router } from 'express';
import { asyncHandler } from '../../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../../shared/auth';
import {
  getEmployeeIntakeLadderHandler,
  getEmployeeKycHandler,
  getMyEmployeeKycHandler,
  listEmployeeKycsHandler,
  recordEmployeeKycHandler,
  requestEmployeeKycHandler,
  reviewEmployeeKycHandler,
} from './employee-kyc.controller';

export const employeeKycRouter = Router();
employeeKycRouter.use(authenticate);

// The employee's own record, read-only. Ahead of /:employeeId so "me" is never an id.
employeeKycRouter.get('/me', asyncHandler(getMyEmployeeKycHandler));

// HR: the queue, one record, recording on the employee's behalf, the decision.
employeeKycRouter.get('/', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(listEmployeeKycsHandler));
// Lot G (Q126/Q141): the intake ladder as data. Literal path, ahead of /:employeeId.
employeeKycRouter.get('/ladder', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(getEmployeeIntakeLadderHandler));
employeeKycRouter.get('/:employeeId', requireRole('ADMIN'), requirePermission('kyc.view'), asyncHandler(getEmployeeKycHandler));
employeeKycRouter.put('/:employeeId', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(recordEmployeeKycHandler));
employeeKycRouter.patch('/:employeeId/review', requireRole('ADMIN'), requirePermission('kyc.approve'), asyncHandler(reviewEmployeeKycHandler));
// N3-B: the one-click Digio request — the catalogue's KYC edit tier beside ADMIN (a role config granted
// `kyc.edit` may send it; the super admin and an admin with no role config pass under the launch rule).
employeeKycRouter.post('/:employeeId/request', requireRole('ADMIN'), requirePermission('kyc.edit'), asyncHandler(requestEmployeeKycHandler));
