import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { findSigningRequest, onSigningCompleted, openSigningRequest, signingStanding, type SigningRow, type SigningStanding } from '../agreements';
import { inviteEmployeeToConsole } from './employees.service';
import type { CreateEmployeeInput } from './employees.schema';

/**
 * DS-2 (Digio eSign, 22 Sep 2026): the employee's appointment letter and
 * NDA — the owner's table: "sent from Employees › New; hosted signing page
 * by SMS/email link; gates the console account".
 *
 * `POST /employees` opens the request when the policy asks for one, and
 * when the same call asked for a console invitation the invitation waits:
 * it rides the request as its `followUp` and is sent by the completion
 * hook the moment the letter is signed. Digio's own link (email or SMS)
 * is the hosted signing page — the employee needs no app. With the policy
 * off nothing here asks, and the invitation goes out at once as before.
 */

export const APPOINTMENT_KIND = 'EMPLOYEE_APPOINTMENT' as const;

type AppointmentFollowUp = {
  inviteToConsole: NonNullable<CreateEmployeeInput['inviteToConsole']> | null;
  invitedByUserId: string;
  email: string | null;
};

export type AppointmentView = {
  required: boolean;
  satisfied: boolean;
  status: string | null;
  requestId: string | null;
  signingUrl: string | null;
  mock: boolean;
  expiresAt: Date | null;
  completedAt: Date | null;
  signedFileId: string | null;
  /** True while a console invitation waits on the signature. */
  inviteDeferred: boolean;
};

export async function appointmentStanding(employeeId: string): Promise<SigningStanding> {
  return signingStanding('EMPLOYEE', employeeId, APPOINTMENT_KIND);
}

export function appointmentView(standing: SigningStanding | null, followUp?: unknown): AppointmentView {
  const request = standing?.request ?? null;
  const open = Boolean(request && ['REQUESTED', 'PARTIALLY_SIGNED'].includes(request.status));
  const deferred = Boolean(open && (followUp as AppointmentFollowUp | null | undefined)?.inviteToConsole);
  return {
    required: standing?.required ?? false,
    satisfied: standing?.satisfied ?? true,
    status: standing?.status ?? null,
    requestId: request?.id ?? null,
    signingUrl: open ? (request?.signingUrl ?? null) : null,
    mock: request?.mock ?? false,
    expiresAt: request?.expiresAt ?? null,
    completedAt: request?.completedAt ?? null,
    signedFileId: request?.files.signed ?? null,
    inviteDeferred: deferred,
  };
}

/**
 * At Employees › New: open the request when the policy asks. Returns the
 * request when one is open (fresh or already there), null when the policy
 * does not ask; a rail that cannot answer is logged and reported, never
 * thrown — the record exists, the letter can be sent again from the
 * Signatures desk.
 */
export async function requestAppointmentSignature(
  employee: { id: string; user: { email: string | null } },
  byUserId: string,
  inviteToConsole: CreateEmployeeInput['inviteToConsole'] | undefined,
): Promise<{ requestId: string | null; created: boolean; inviteDeferred: boolean; reason: string | null }> {
  const followUp: AppointmentFollowUp = { inviteToConsole: inviteToConsole ?? null, invitedByUserId: byUserId, email: employee.user.email };
  try {
    const { request, created } = await openSigningRequest({ kind: APPOINTMENT_KIND, partyType: 'EMPLOYEE', partyId: employee.id, requestedById: byUserId, followUp });
    if (request.status === 'COMPLETED') return { requestId: null, created: false, inviteDeferred: false, reason: null };
    return { requestId: request.id, created, inviteDeferred: Boolean(inviteToConsole), reason: null };
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'SIGNING_NOT_OPEN') return { requestId: null, created: false, inviteDeferred: false, reason: null };
    logger.error('Employee appointment: could not open the signing request', { employeeId: employee.id, err: cause });
    return { requestId: null, created: false, inviteDeferred: false, reason: cause instanceof ApiError ? cause.message : 'The signing rail did not answer' };
  }
}

/** The completion hook: the console invitation that waited on the letter goes out now. Registered at bootstrap. */
export async function onAppointmentSigned(request: SigningRow): Promise<void> {
  const followUp = request.followUp as AppointmentFollowUp | null;
  if (!followUp?.inviteToConsole) return;
  if (!followUp.email) {
    logger.warn('Employee appointment signed but the person has no email for the console invitation', { requestId: request.id, employeeId: request.partyId });
    return;
  }
  await inviteEmployeeToConsole(followUp.email, followUp.inviteToConsole, followUp.invitedByUserId);
}

/** The follow-up on an open request — what the detail read needs to say "the invitation waits". */
export async function appointmentFollowUp(requestId: string): Promise<unknown> {
  return (await findSigningRequest(requestId))?.followUp ?? null;
}

export function registerAppointmentSigningHooks(): void {
  onSigningCompleted(APPOINTMENT_KIND, onAppointmentSigned);
}
