import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DS-2 (Digio eSign, 22 Sep 2026): the employee's appointment letter.
 *
 * What is pinned: Employees › New opens the request when the policy asks,
 * and a console invitation asked for in the same breath waits on the
 * signature — it rides the request and goes out from the completion hook;
 * with the policy off (or the letter already signed) the invitation goes
 * out at once as before; the detail read says the invitation waits.
 */

const { agreements, invites } = vi.hoisted(() => ({
  agreements: { signingStanding: vi.fn(), openSigningRequest: vi.fn(), findSigningRequest: vi.fn(), onSigningCompleted: vi.fn() },
  invites: { inviteEmployeeToConsole: vi.fn(async () => ({ id: 'inv_1' })) },
}));

vi.mock('../../agreements', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../agreements')>()), ...agreements }));
vi.mock('../employees.service', () => invites);

import { appointmentView, onAppointmentSigned, registerAppointmentSigningHooks, requestAppointmentSignature } from '../appointment-signing';

const employee = { id: 'emp_1', user: { email: 'asha@adx.in' } };
const invite = { method: 'PASSWORD' as const, roleConfigId: 'role_ops' };

beforeEach(() => vi.clearAllMocks());

describe('at Employees › New', () => {
  it('opens the request with the invitation riding it, and the invitation waits', async () => {
    agreements.openSigningRequest.mockResolvedValueOnce({ request: { id: 'sig_e1', status: 'REQUESTED' }, created: true });
    expect(await requestAppointmentSignature(employee, 'adm_1', invite)).toEqual({ requestId: 'sig_e1', created: true, inviteDeferred: true, reason: null });
    expect(agreements.openSigningRequest).toHaveBeenCalledWith({ kind: 'EMPLOYEE_APPOINTMENT', partyType: 'EMPLOYEE', partyId: 'emp_1', requestedById: 'adm_1', followUp: { inviteToConsole: invite, invitedByUserId: 'adm_1', email: 'asha@adx.in' } });
    expect(invites.inviteEmployeeToConsole).not.toHaveBeenCalled();
  });

  it('asks nothing when the policy does not, or the letter is already signed; reports a rail that cannot answer', async () => {
    const { ApiError } = await import('../../../shared/errors');
    agreements.openSigningRequest.mockRejectedValueOnce(new ApiError(409, 'SIGNING_NOT_OPEN', 'off'));
    expect(await requestAppointmentSignature(employee, 'adm_1', invite)).toEqual({ requestId: null, created: false, inviteDeferred: false, reason: null });
    agreements.openSigningRequest.mockResolvedValueOnce({ request: { id: 'sig_old', status: 'COMPLETED' }, created: false });
    expect(await requestAppointmentSignature(employee, 'adm_1', undefined)).toEqual({ requestId: null, created: false, inviteDeferred: false, reason: null });
    agreements.openSigningRequest.mockRejectedValueOnce(new ApiError(503, 'NO_ACTIVE_TEMPLATE', 'No employee appointment and nda is published yet'));
    expect(await requestAppointmentSignature(employee, 'adm_1', invite)).toMatchObject({ requestId: null, reason: 'No employee appointment and nda is published yet' });
  });
});

describe('once signed', () => {
  it('the hook sends the invitation that waited, by the admin who asked', async () => {
    await onAppointmentSigned({ id: 'sig_e1', partyId: 'emp_1', followUp: { inviteToConsole: invite, invitedByUserId: 'adm_1', email: 'asha@adx.in' } } as never);
    expect(invites.inviteEmployeeToConsole).toHaveBeenCalledWith('asha@adx.in', invite, 'adm_1');
  });

  it('sends nothing when no invitation waited, and registers under the kind', async () => {
    await onAppointmentSigned({ id: 'sig_e2', partyId: 'emp_1', followUp: null } as never);
    await onAppointmentSigned({ id: 'sig_e3', partyId: 'emp_1', followUp: { inviteToConsole: invite, invitedByUserId: 'adm_1', email: null } } as never);
    expect(invites.inviteEmployeeToConsole).not.toHaveBeenCalled();
    registerAppointmentSigningHooks();
    expect(agreements.onSigningCompleted).toHaveBeenCalledWith('EMPLOYEE_APPOINTMENT', onAppointmentSigned);
  });
});

describe('the detail read', () => {
  it('says the invitation waits while the letter is open', () => {
    const open = { kind: 'EMPLOYEE_APPOINTMENT', required: true, satisfied: false, status: 'REQUESTED', currentVersion: 1, request: { id: 'sig_e1', status: 'REQUESTED', signingUrl: 'https://gateway.test/#/e', mock: true, expiresAt: new Date(), completedAt: null, files: { document: 'f1', signed: null, certificate: null } } } as never;
    expect(appointmentView(open, { inviteToConsole: invite })).toMatchObject({ required: true, satisfied: false, requestId: 'sig_e1', signingUrl: 'https://gateway.test/#/e', mock: true, inviteDeferred: true });
    expect(appointmentView(open, null)).toMatchObject({ inviteDeferred: false });
    expect(appointmentView(null)).toMatchObject({ required: false, satisfied: true, requestId: null, inviteDeferred: false });
  });
});
