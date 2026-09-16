import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { auditDiff, logActivity } from '../../../shared/audit';
import type { KycStatus } from '../../../shared/database';
import { kycStateCounts } from '../../../shared/kyc-state';
import { notify } from '../../notifications';
import { employeeExists, findEmployeeForUser } from './employee-lookup.port';
import { kycChannelLabel, pageMeta, type KycRequestInput } from '../kyc.schema';
import { kycCaseExtras } from '../case-read';
import { initiateEmployeeDigioKyc } from './employee-digio.service';
import { prismaEmployeeKycRepository as repository } from './prisma-employee-kyc.repository';
import type { EmployeeKycFilter } from './employee-kyc.repository';
import type { EmployeeKycDocuments } from './employee-kyc.schema';
import { employeeIntakeLadder, intakeProgress, type IntakeLadderView } from './intake-ladder';

/**
 * Lot D (Q131) — an employee's own KYC, the agent record's twin.
 *
 * Employees are onboarded through the intake form and only ever sign in, so
 * their documents are recorded ON THEIR BEHALF by the admin who met them,
 * and the record remembers who that was. The review is the same decision
 * every other KYC row gets; the employee can read their own status. N3-B:
 * every employee is in the queue from the moment the row exists
 * (AWAITING_DOCUMENTS), and HR can ask them for their KYC with one click —
 * a Digio session on their behalf.
 */

/** The deep link a KYC_REQUESTED push opens for an employee: their KYC screen. */
export const EMPLOYEE_KYC_DEEP_LINK = 'adx://employee/kyc';

/**
 * `GET /employee-kyc` — N3-B: every employee, left-joined to their record,
 * in one of six states; `meta.counts` is employees per state over the
 * filter with the state facet removed.
 */
export async function listEmployeeKycs(where: EmployeeKycFilter, page: number, pageSize: number) {
  const [{ items, total }, counts] = await Promise.all([repository.findPage(where, page, pageSize), repository.countByState({ ...where, state: undefined, status: undefined })]);
  return { items, meta: { ...pageMeta(page, pageSize, total), counts: kycStateCounts(counts) } };
}

/**
 * The desk's case read (ADMIN): the row and, E7-3, its age against the SLA
 * with the reviewer and recorder by name; Lot G (Q141): `intake`, the
 * record laid over the intake ladder — which proofs are on file, which
 * steps are complete — so the desk draws the ladder it still has to climb.
 */
export async function getEmployeeKyc(employeeId: string, now = new Date()) {
  const kyc = await repository.findByEmployeeId(employeeId);
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'No KYC recorded for this employee');
  const [extras, ladder] = await Promise.all([kycCaseExtras(kyc, now), employeeIntakeLadder()]);
  return { ...kyc, ...extras, intake: intakeProgress(ladder, kyc as Record<string, unknown>) };
}

/** GET /employee-kyc/ladder — Lot G (Q126/Q141): the intake ladder as data, `source` saying whether it is the console's or the code's. */
export const getEmployeeIntakeLadder = (): Promise<IntakeLadderView> => employeeIntakeLadder();

/** The employee reading their own record. Null when nothing is recorded yet. */
export async function getMyEmployeeKyc(userId: string) {
  const employee = await findEmployeeForUser(userId);
  if (!employee) throw new ApiError(404, 'NOT_FOUND', 'Employee record not found');
  return repository.findByEmployeeId(employee.id);
}

/**
 * Recording is an upsert: HR can record what they have and come back for
 * the rest, and a fresh recording after a rejection sends the record back
 * to PENDING with the reason cleared. The recorder is written every time.
 */
export async function recordEmployeeKyc(employeeId: string, data: EmployeeKycDocuments, recordedById: string, req?: Request) {
  if (!(await employeeExists(employeeId))) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');
  const recorded = await repository.record(employeeId, data, recordedById);
  await logActivity(recordedById, 'EMPLOYEE_KYC_RECORDED', {
    req,
    targetType: 'EmployeeKyc',
    targetId: recorded.id,
    module: 'kyc',
    metadata: { employeeId, fields: Object.keys(data) },
  });
  return recorded;
}

/* ── N3-B: the one click ─────────────────────────────────────────────────── */

/**
 * `POST /employee-kyc/:employeeId/request { channel = DIGIO, note? }` — HR
 * asks the employee for their KYC, the agent's twin. DIGIO opens a Digio
 * session on the employee's behalf (the same client, the `adx-emp-`
 * reference, the webhook landing on the employee's record); MANUAL only
 * tells them. Either way the row is made if there is none and stamped (who,
 * when, which channel; the status untouched — REQUESTED is derived), the
 * employee is told by `KYC_REQUESTED`, and `EMPLOYEE_KYC_REQUESTED` is
 * audited. 404 for an employee that is not there; 409 `KYC_ALREADY_VERIFIED`
 * once verified.
 */
export async function requestEmployeeKyc(employeeId: string, input: KycRequestInput, byUserId: string, req?: Request, now = new Date()) {
  const employee = await repository.findEmployeeContact(employeeId);
  if (!employee) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');
  const current = await repository.findByEmployeeId(employeeId);
  if (current?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This employee is already verified; there is nothing to request');
  }

  const digio = input.channel === 'DIGIO' ? await initiateEmployeeDigioKyc(employee, now) : null;
  const kyc = await repository.requestKyc(employeeId, { requestedById: byUserId, requestedChannel: input.channel, at: now });

  await logActivity(byUserId, 'EMPLOYEE_KYC_REQUESTED', {
    req,
    targetType: 'EmployeeKyc',
    targetId: kyc.id,
    module: 'kyc',
    diff: auditDiff(current ?? {}, kyc, ['requestedAt', 'requestedChannel', 'method']),
    metadata: { employeeId, channel: input.channel, note: input.note ?? null, digioKycId: digio?.kycId ?? null },
  });

  const partyName = employee.user.name ?? employee.displayId ?? 'there';
  await notify(
    'KYC_REQUESTED',
    employee.userId,
    { partyName, channel: kycChannelLabel(input.channel), note: input.note ?? '', deepLink: EMPLOYEE_KYC_DEEP_LINK },
    {
      inApp: {
        type: 'KYC',
        title: 'Please complete your verification',
        message:
          input.channel === 'DIGIO'
            ? `ADX has started a Digio identity check for you. Finish it from the link Digio sent — it takes about a minute. ${input.note ?? ''}`.trim()
            : `ADX has asked you to complete your identity verification with HR. ${input.note ?? ''}`.trim(),
        suggestedAction: 'Verify your identity',
        relatedId: kyc.id,
      },
    },
  );

  return { kyc, digio: digio ? { kycId: digio.kycId, validTill: digio.validTill } : null, notified: true };
}

export async function reviewEmployeeKyc(
  employeeId: string,
  status: KycStatus,
  rejectionReason: string | undefined,
  reviewedById: string,
  req?: Request,
) {
  const before = await getEmployeeKyc(employeeId);
  if (status === 'REJECTED' && !rejectionReason?.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the record is rejected');
  }
  const after = await repository.review(employeeId, status, rejectionReason?.trim() ?? null, reviewedById);
  await logActivity(reviewedById, 'EMPLOYEE_KYC_REVIEWED', {
    req,
    targetType: 'EmployeeKyc',
    targetId: after.id,
    module: 'kyc',
    diff: auditDiff(before, after, ['status', 'rejectionReason']),
    metadata: { employeeId },
  });
  return after;
}
