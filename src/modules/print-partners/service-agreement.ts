import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { assertSigned, openSigningRequest, signingStanding, type SigningStanding } from '../agreements';

/**
 * DS-2 (Digio eSign, 22 Sep 2026): the print partner's service agreement,
 * signed once KYC verifies — the owner's table: "signed after KYC verifies;
 * gates quote requests and jobs; door on the partner's profile".
 *
 * The moment the partner's KYC record turns VERIFIED — the desk's decision
 * or Digio's webhook — the request is opened and the partner told; the
 * partner's floor carries it (`GET /print-partners/me` → `agreement`), and
 * until it is signed a quote (`POST …/quotes`) and a job's Accept answer
 * 403 SIGNATURE_REQUIRED with the request, so the app sends them to the
 * signing screen. With the policy off, or the document switched off,
 * nothing here asks for anything and the gates are open as before.
 */

export const SERVICE_AGREEMENT_KIND = 'PRINT_PARTNER_SERVICE' as const;

/** The slice the partner's read and the desk's detail carry. */
export type ServiceAgreementView = {
  required: boolean;
  satisfied: boolean;
  status: string | null;
  requestId: string | null;
  signingUrl: string | null;
  mock: boolean;
  expiresAt: Date | null;
  completedAt: Date | null;
  signedFileId: string | null;
  label: string | null;
};

export async function serviceAgreementStanding(partnerId: string): Promise<SigningStanding> {
  return signingStanding('PRINT_PARTNER', partnerId, SERVICE_AGREEMENT_KIND);
}

export function serviceAgreementView(standing: SigningStanding | null): ServiceAgreementView {
  const request = standing?.request ?? null;
  const open = Boolean(request && ['REQUESTED', 'PARTIALLY_SIGNED'].includes(request.status));
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
    label: request?.label ?? null,
  };
}

/** The floor's read: the standing as the app shows it; null on a rail that did not answer, which the app reads as "nothing asked". */
export async function serviceAgreementFor(partnerId: string): Promise<ServiceAgreementView> {
  return serviceAgreementView(await serviceAgreementStanding(partnerId).catch(() => null));
}

/** 403 SIGNATURE_REQUIRED carrying the open request, or nothing. */
export async function assertServiceAgreementSigned(partnerId: string, what: string): Promise<void> {
  const standing = await serviceAgreementStanding(partnerId);
  if (standing.satisfied) return;
  if (!standing.request) {
    // Required but never opened (KYC verified before the policy was switched on): open it now, so the refusal carries a link.
    const opened = await requestServiceAgreement(partnerId, null);
    if (opened.requestId) {
      const fresh = await serviceAgreementStanding(partnerId);
      assertSigned(fresh, what);
      return;
    }
    throw new ApiError(403, 'SIGNATURE_REQUIRED', `${what} needs the service agreement signed first — ADX will send it to you`, { signing: null, kind: SERVICE_AGREEMENT_KIND });
  }
  assertSigned(standing, what);
}

/**
 * On KYC VERIFIED: open the request when the policy asks for one. Never
 * fails the verification; a rail that cannot answer is logged, and the
 * partner's next gated act asks again.
 */
export async function requestServiceAgreement(partnerId: string, byUserId: string | null): Promise<{ opened: boolean; requestId: string | null; reason: string | null }> {
  try {
    const { request, created } = await openSigningRequest({ kind: SERVICE_AGREEMENT_KIND, partyType: 'PRINT_PARTNER', partyId: partnerId, requestedById: byUserId });
    return { opened: created, requestId: request.id, reason: null };
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'SIGNING_NOT_OPEN') return { opened: false, requestId: null, reason: null };
    logger.error('Print partner service agreement: could not open the signing request', { partnerId, err: cause });
    return { opened: false, requestId: null, reason: cause instanceof ApiError ? cause.message : 'The signing rail did not answer' };
  }
}
