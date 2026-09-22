import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DS-2 (Digio eSign, 22 Sep 2026): the print partner's service agreement.
 *
 * What is pinned: KYC turning VERIFIED asks for the signature when the
 * policy does (and never fails the verification when the rail cannot); a
 * quote and a job's Accept are refused 403 SIGNATURE_REQUIRED with the
 * request until it is signed — and a partner the policy caught after
 * verification has the request opened on the spot, so the refusal carries
 * a link; the floor's read shows the door; with the rail off nothing asks.
 */

const { agreements } = vi.hoisted(() => ({
  agreements: { signingStanding: vi.fn(), openSigningRequest: vi.fn() },
}));

vi.mock('../../agreements', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../agreements')>()), ...agreements }));

import { assertServiceAgreementSigned, requestServiceAgreement, serviceAgreementFor, serviceAgreementView } from '../service-agreement';

const request = (status: string) => ({ id: 'sig_p1', status, signingUrl: 'https://gateway.test/#/p', mock: false, expiresAt: new Date('2026-10-07'), completedAt: status === 'COMPLETED' ? new Date() : null, files: { document: 'f1', signed: status === 'COMPLETED' ? 'f2' : null, certificate: null }, label: 'Print partner service agreement' });
const standing = (over: Record<string, unknown>) => ({ kind: 'PRINT_PARTNER_SERVICE', required: true, satisfied: false, status: null, currentVersion: 1, request: null, ...over }) as never;

beforeEach(() => vi.clearAllMocks());

describe('the trigger', () => {
  it('opens the request on VERIFIED, and is quiet when the policy does not ask or the rail cannot', async () => {
    agreements.openSigningRequest.mockResolvedValueOnce({ request: { id: 'sig_p1' }, created: true });
    expect(await requestServiceAgreement('prt_1', 'adm_1')).toEqual({ opened: true, requestId: 'sig_p1', reason: null });
    expect(agreements.openSigningRequest).toHaveBeenCalledWith({ kind: 'PRINT_PARTNER_SERVICE', partyType: 'PRINT_PARTNER', partyId: 'prt_1', requestedById: 'adm_1' });

    const { ApiError } = await import('../../../shared/errors');
    agreements.openSigningRequest.mockRejectedValueOnce(new ApiError(409, 'SIGNING_NOT_OPEN', 'off'));
    expect(await requestServiceAgreement('prt_1', null)).toEqual({ opened: false, requestId: null, reason: null });
    agreements.openSigningRequest.mockRejectedValueOnce(new Error('rail down'));
    expect(await requestServiceAgreement('prt_1', null)).toEqual({ opened: false, requestId: null, reason: 'The signing rail did not answer' });
  });
});

describe('the gates', () => {
  it('refuse with the open request until it is signed', async () => {
    agreements.signingStanding.mockResolvedValue(standing({ status: 'REQUESTED', request: request('REQUESTED') }));
    await expect(assertServiceAgreementSigned('prt_1', 'Quoting')).rejects.toMatchObject({ statusCode: 403, code: 'SIGNATURE_REQUIRED', details: { signing: expect.objectContaining({ id: 'sig_p1' }) } });
    agreements.signingStanding.mockResolvedValue(standing({ satisfied: true, status: 'COMPLETED', request: request('COMPLETED') }));
    await expect(assertServiceAgreementSigned('prt_1', 'Quoting')).resolves.toBeUndefined();
  });

  it('open the request on the spot for a partner verified before the policy was switched on', async () => {
    agreements.signingStanding.mockResolvedValueOnce(standing({}));
    agreements.openSigningRequest.mockResolvedValueOnce({ request: { id: 'sig_p1' }, created: true });
    agreements.signingStanding.mockResolvedValueOnce(standing({ status: 'REQUESTED', request: request('REQUESTED') }));
    await expect(assertServiceAgreementSigned('prt_1', 'Accepting a job')).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED', details: { signing: expect.objectContaining({ id: 'sig_p1' }) } });
    expect(agreements.openSigningRequest).toHaveBeenCalledTimes(1);
  });

  it('stand open while the rail is off', async () => {
    agreements.signingStanding.mockResolvedValue(standing({ required: false, satisfied: true }));
    await expect(assertServiceAgreementSigned('prt_1', 'Quoting')).resolves.toBeUndefined();
    expect(agreements.openSigningRequest).not.toHaveBeenCalled();
  });
});

describe('the door', () => {
  it('shows the link while open, the signed copy once done, and nothing when the rail did not answer', async () => {
    expect(serviceAgreementView(standing({ status: 'REQUESTED', request: request('REQUESTED') }))).toMatchObject({ required: true, satisfied: false, requestId: 'sig_p1', signingUrl: 'https://gateway.test/#/p', signedFileId: null });
    expect(serviceAgreementView(standing({ satisfied: true, status: 'COMPLETED', request: request('COMPLETED') }))).toMatchObject({ satisfied: true, signingUrl: null, signedFileId: 'f2' });
    agreements.signingStanding.mockRejectedValueOnce(new Error('rail down'));
    expect(await serviceAgreementFor('prt_1')).toMatchObject({ required: false, satisfied: true, requestId: null });
  });
});
