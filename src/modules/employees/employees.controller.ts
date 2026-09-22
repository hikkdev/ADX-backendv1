import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { createEmployeeSchema, listEmployeesQuerySchema, updateEmployeeSchema, workloadQuerySchema } from './employees.schema';
import { workloadReport } from './workload.service';
import {
  createEmployee,
  deleteEmployee,
  getEmployeeByUserId,
  inviteEmployeeToConsole,
  listEmployees,
  listEmployeesPage,
  updateEmployee,
  employeesOverview,
} from './employees.service';
import { appointmentFollowUp, appointmentStanding, appointmentView, requestAppointmentSignature } from './appointment-signing';

/** The fields an audit diff on an HR record reports; the document URLs are not among them. */
const AUDITED_FIELDS = ['department', 'departmentId', 'designation', 'isActive', 'externalHrmsId', 'region', 'workMode', 'employmentType'] as const;

export async function createEmployeeHandler(req: Request, res: Response): Promise<void> {
  const parsed = createEmployeeSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { employee, inviteToConsole } = await createEmployee(parsed.data);

  // The console invitation, when asked for, is sent after the record exists:
  // an invitation without an employee row behind it is the worse half-state
  // of the two, because it is a live credential.
  if (inviteToConsole && !employee.user.email) {
    throw new ApiError(409, 'CONFLICT', 'That person has no email address, so they cannot be invited to the console.');
  }
  // DS-2: the appointment letter is e-signed when the policy asks; the
  // invitation then waits on the signature and goes out from the hook.
  const signing = await requestAppointmentSignature(employee, req.user!.sub, inviteToConsole);
  let invite = null;
  if (inviteToConsole && !signing.requestId) {
    invite = await inviteEmployeeToConsole(employee.user.email!, inviteToConsole, req.user!.sub);
  }

  await logActivity(req.user!.sub, 'EMPLOYEE_CREATED', {
    req,
    module: 'employees',
    targetType: 'Employee',
    targetId: employee.id,
    metadata: {
      userId: employee.userId,
      displayId: employee.displayId,
      ...(invite ? { inviteId: invite.id } : {}),
      ...(signing.requestId ? { signingRequestId: signing.requestId, inviteDeferred: signing.inviteDeferred } : {}),
    },
  });

  res.status(201).json({
    success: true,
    data: {
      ...employee,
      ...(invite ? { invite } : {}),
      appointment: signing.requestId
        ? { requestId: signing.requestId, inviteDeferred: signing.inviteDeferred, reason: null }
        : { requestId: null, inviteDeferred: false, reason: signing.reason ?? null },
    },
  });
}

export async function getAllEmployeesHandler(req: Request, res: Response): Promise<void> {
  const parsed = listEmployeesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  // E10-1: `page` in the query asks for the list contract; the `meta`
  // sibling stays beside it one release. Q-B (owner's item 8): so does
  // `pageSize` on its own — employee-kyc's console read sends `pageSize=100`
  // without `page` and was getting the bare array by accident. With neither,
  // the bare array, kept for the two readers that exist.
  if (req.query['page'] !== undefined || req.query['pageSize'] !== undefined) {
    const page = await listEmployeesPage(parsed.data);
    res.json({
      success: true,
      data: page,
      meta: { page: page.page, pageSize: page.pageSize, total: page.total, totalPages: Math.ceil(page.total / page.pageSize) },
    });
    return;
  }

  const { items, meta } = await listEmployees(parsed.data);

  // `meta` is a sibling of `data`, not nested inside it. Clients depend on this.
  res.json({ success: true, data: items, meta });
}

export async function getEmployeeByUserIdHandler(req: Request, res: Response): Promise<void> {
  const employee = await getEmployeeByUserId(req.params['userId'] as string, req.user);
  // DS-2: where the appointment letter stands, beside the KYC.
  const standing = await appointmentStanding(employee.id).catch(() => null);
  res.json({ success: true, data: { ...employee, appointment: appointmentView(standing, standing?.request ? await appointmentFollowUp(standing.request.id) : null) } });
}

export async function updateEmployeeHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateEmployeeSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  // Validation precedes the existence check, matching the original controller.
  const { before, after } = await updateEmployee(req.params['userId'] as string, parsed.data);

  await logActivity(req.user!.sub, 'EMPLOYEE_UPDATED', {
    req,
    module: 'employees',
    targetType: 'Employee',
    targetId: after.id,
    diff: auditDiff(before, after, AUDITED_FIELDS),
    // Which documents were touched, never their URLs.
    metadata: { userId: after.userId, fields: Object.keys(parsed.data) },
  });

  res.json({ success: true, data: after });
}

export async function deleteEmployeeHandler(req: Request, res: Response): Promise<void> {
  const employee = await deleteEmployee(req.params['userId'] as string);

  await logActivity(req.user!.sub, 'EMPLOYEE_DELETED', {
    req,
    module: 'employees',
    targetType: 'Employee',
    targetId: employee.id,
    metadata: { userId: employee.userId, displayId: employee.displayId },
  });

  res.json({ success: true, data: { message: 'Employee deleted' } });
}

/**
 * GET /employees/workload — Lot G (Q120/Q139): the workload measure over a
 * window, bucketed by week or month; see `workload.service.ts` for what it
 * counts. A window past a year is refused rather than walked.
 */
// GET /employees/overview — G13-B: the headcount and the open positions.
export async function overviewHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await employeesOverview() });
}

export async function workloadHandler(req: Request, res: Response): Promise<void> {
  const parsed = workloadQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await workloadReport(parsed.data) });
  } catch (err) {
    if (err instanceof Error && err.message === 'WINDOW_TOO_WIDE') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'The window may span at most a year');
    }
    throw err;
  }
}
