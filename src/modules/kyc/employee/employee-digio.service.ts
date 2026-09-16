import { logger } from '../../../shared/logging';
import { ApiError } from '../../../shared/errors';
import { requestDigioKyc, type DigioWebhookPayload } from '../../../shared/integrations/digio-client';
import { notify } from '../../notifications';
import { prismaEmployeeKycRepository as repository } from './prisma-employee-kyc.repository';
import type { EmployeeContact } from './employee-kyc.repository';

/**
 * KYC by Digio for an employee — N3-B, the agent's twin for staff.
 *
 * Employees are individuals with a user, so the session is the same request
 * every other party makes through `shared/integrations/digio-client`, the
 * customer being the employee's own name, email and mobile, recorded on the
 * employee's row. The reference ADX hands Digio is `adx-emp-<employeeId>-<ts>`;
 * the webhook is routed by the request id Digio minted — ADX has one
 * callback, owned by `publishers`, and a request id no publisher row claims
 * is offered to the handlers registered at boot; `handleEmployeeDigioWebhook`
 * is one of them (`bootstrap/register-modules`).
 *
 * Only the desk opens a session (`POST /employee-kyc/:employeeId/request`,
 * channel DIGIO — the default). `submittedAt` is left for the webhook, so
 * the queue reads REQUESTED until Digio answers.
 */

export const DIGIO_REFERENCE_PREFIX = 'adx-emp-';

export type DigioSession = { kycId: string; accessToken: string; validTill: string; sdkUrl: string };

export async function initiateEmployeeDigioKyc(employee: EmployeeContact, now = new Date()): Promise<DigioSession> {
  const current = await repository.findByEmployeeId(employee.id);
  if (current?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This employee is already verified; there is nothing to start');
  }
  const referenceId = `${DIGIO_REFERENCE_PREFIX}${employee.id}-${now.getTime()}`;
  const session = await requestDigioKyc({
    referenceId,
    customerName: employee.user.name ?? employee.displayId ?? employee.id,
    customerEmail: employee.user.email ?? '',
    customerMobile: employee.user.mobile,
  });
  await repository.upsertDigio(employee.id, { method: 'DIGIO', digioRequestId: session.kycId, digioReferenceId: referenceId, digioStatus: 'pending' });
  return { kycId: session.kycId, accessToken: session.accessToken, validTill: session.validTill, sdkUrl: session.sdkUrl };
}

/**
 * Claims a webhook whose request id is an employee's; false when it is not.
 * The decision lands on the row (`recordedVia` DIGIO, `method` DIGIO on an
 * approval, `submittedAt` stamped where the desk's request left it empty)
 * and the employee is told through `KYC_DECISION`.
 */
export async function handleEmployeeDigioWebhook(payload: DigioWebhookPayload, now = new Date()): Promise<boolean> {
  const row = await repository.findByDigioRequestId(payload.id);
  if (!row) return false;

  const approved = payload.status === 'approved';
  const rejected = payload.status === 'rejected';
  const decision = approved ? 'VERIFIED' : rejected ? 'REJECTED' : 'PENDING';
  const completedAt = payload.completed_at ? new Date(payload.completed_at) : undefined;

  await repository.applyDigioWebhook(row.id, {
    digioStatus: payload.status,
    digioPayload: payload,
    digioVerifiedAt: completedAt ?? (approved ? now : undefined),
    status: decision,
    reviewedAt: approved || rejected ? now : undefined,
    rejectionReason: rejected ? (payload.message ?? 'KYC rejected by Digio') : undefined,
    submittedAt: row.submittedAt ?? completedAt ?? now,
  });

  logger.info('Digio webhook applied to an employee', { kycId: payload.id, status: payload.status, employeeId: row.employeeId });

  if (decision === 'PENDING') return true;

  await notify(
    'KYC_DECISION',
    row.employee.userId,
    {
      partyName: row.employee.user.name ?? row.employee.displayId ?? 'there',
      decision: approved ? 'verified' : 'not verified',
      reason: approved ? 'Your identity is on file.' : (payload.message ?? 'You can try again, or bring your documents to HR.'),
    },
    {
      inApp: {
        type: 'KYC',
        title: approved ? 'Identity verified' : 'Identity check did not clear',
        message: approved ? 'Digio has verified your identity.' : `Digio could not verify you. ${payload.message ?? 'You can try again, or bring your documents to HR.'}`,
        suggestedAction: approved ? 'Open your profile' : 'Open KYC',
        relatedId: row.id,
      },
    },
  );
  return true;
}
