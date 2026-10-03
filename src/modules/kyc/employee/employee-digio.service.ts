import { logger } from '../../../shared/logging';
import { ApiError } from '../../../shared/errors';
import type { DigioWebhookPayload } from '../../../shared/integrations/digio-client';
import { workflowKeyFor } from '../../../shared/integrations/digio-workflows';
import { digioAnswerOf, hostedProviderName, hostedProviderOf, isDigioRequestOpen, partyKycAnswer, startPartyKyc, type BackupCasePort } from '../../../shared/verification';
import { digioDecisionOf, isStaleDigioCallback } from '../../../shared/integrations/digio-callback';
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
  const customerName = employee.user.name ?? employee.displayId ?? employee.id;
  // Cashfree Phase 1: asked through the verification router. Only the desk opens an employee's
  // session, so no Cashfree session is handed out here; with the backup ON a technical failure
  // marks the record PROVIDER_FAILED and the desk is offered "Resend on backup".
  const started = await startPartyKyc(
    {
      caseType: 'EMPLOYEE_KYC',
      caseId: employee.id,
      digio: {
        party: 'EMPLOYEE',
        // Phase D: the workflow by employment type — full time (part time too, until the owner says otherwise), or intern / contract.
        workflowKey: workflowKeyFor({ party: 'EMPLOYEE', employmentType: employee.employmentType ?? null }),
        referenceId,
        customerName,
        customerEmail: employee.user.email ?? '',
        customerMobile: employee.user.mobile,
      },
      origin: 'DESK',
      digioRequestOpen: isDigioRequestOpen(current),
      ownerUserId: employee.userId,
      subject: { name: customerName, party: 'EMPLOYEE', business: false },
      markProviderFailed: () => repository.markProviderFailed(employee.id),
    },
    now,
  );
  await repository.upsertDigio(employee.id, { method: started.provider, digioRequestId: started.requestId, digioReferenceId: referenceId, digioStatus: 'pending' });
  return digioAnswerOf(partyKycAnswer(started, undefined));
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

  const decision = digioDecisionOf(payload.status);
  const approved = decision === 'VERIFIED';
  const rejected = decision === 'REJECTED';
  const completedAt = payload.completed_at ? new Date(payload.completed_at) : undefined;

  // Phase D: a late or unknown status never un-decides the record (`digio-callback.ts`).
  if (isStaleDigioCallback(row.status, decision)) {
    logger.info('Digio webhook left a decided employee record as it was', { kycId: payload.id, status: payload.status, recordStatus: row.status });
    return true;
  }

  // Cashfree Phase 1: a Cashfree session's outcome comes down this road too — its request id says so.
  const via = hostedProviderOf(payload.id);
  const verifier = hostedProviderName(via);

  await repository.applyDigioWebhook(row.id, {
    via,
    digioStatus: payload.status,
    digioPayload: payload,
    digioVerifiedAt: completedAt ?? (approved ? now : undefined),
    status: decision,
    reviewedAt: approved || rejected ? now : undefined,
    rejectionReason: rejected ? (payload.message ?? `KYC rejected by ${verifier}`) : undefined,
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
        message: approved ? `${verifier} has verified your identity.` : `${verifier} could not verify you. ${payload.message ?? 'You can try again, or bring your documents to HR.'}`,
        suggestedAction: approved ? 'Open your profile' : 'Open KYC',
        relatedId: row.id,
      },
    },
  );
  return true;
}

/**
 * Cashfree Phase 1: an employee's KYC case, for the desk's "Resend on
 * backup" (registered as `EMPLOYEE_KYC`, keyed by the employee id) — the
 * only way an employee reaches a Cashfree session, since only the desk
 * opens theirs. The bank step verifies the salary or stipend account.
 */
export const employeeBackupCase: BackupCasePort = {
  async load(employeeId) {
    const employee = await repository.findEmployeeContact(employeeId);
    if (!employee) return null;
    const record = await repository.findByEmployeeId(employeeId);
    return {
      ownerUserId: employee.userId,
      subject: { name: employee.user.name ?? employee.displayId ?? employee.id, party: 'EMPLOYEE', business: false },
      workflowKey: workflowKeyFor({ party: 'EMPLOYEE', employmentType: employee.employmentType ?? null }),
      verified: record?.status === 'VERIFIED',
    };
  },
  stamp(employeeId, fields) {
    const { at: _at, ...columns } = fields;
    return repository.upsertDigio(employeeId, columns);
  },
};
