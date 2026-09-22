import type { AgreementKind } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { openSigningRequest, signingStanding, type SigningStanding } from '../agreements';
import type { AgentSide } from './application/application.rules';

/**
 * DS-1 (Digio eSign, 22 Sep 2026): the agent's engagement terms, signed.
 *
 * The click at the terms step stays (AG-1: the applicant accepts before
 * review); the e-signature is asked for once, when the desk activates —
 * decision 6, "activation, recommended". Until it is signed the agent is
 * ACTIVE but does not work: the dashboard says so (`application.mayWork`
 * false, `signing` with the request), the agent-initiated writes refuse 403
 * SIGNATURE_REQUIRED, and dispatch skips them. With the policy off, or the
 * document switched off, nothing here asks for anything.
 */

export const ENGAGEMENT_KIND: Record<AgentSide, AgreementKind> = {
  PUBLISHER: 'AGENT_PUBLISHER_PLATFORM',
  ADVERTISER: 'AGENT_ADVERTISER_PLATFORM',
};

/** The side the engagement terms are for: publisher-first when an agent holds both. */
export function engagementSide(roles: readonly string[] | null | undefined): AgentSide {
  const held = roles ?? [];
  return held.includes('AGENT_PUBLISHER') || !held.includes('AGENT_ADVERTISER') ? 'PUBLISHER' : 'ADVERTISER';
}

export async function engagementSigning(agentId: string, side: AgentSide): Promise<SigningStanding> {
  return signingStanding('AGENT', agentId, ENGAGEMENT_KIND[side]);
}

/** 403 SIGNATURE_REQUIRED carrying the open request, or nothing. */
export async function assertEngagementSigned(agentId: string, side: AgentSide): Promise<void> {
  const standing = await engagementSigning(agentId, side);
  if (standing.satisfied) return;
  throw new ApiError(403, 'SIGNATURE_REQUIRED', 'Sign your ADX engagement terms to start working — the document is in the app', { signing: standing.request, kind: standing.kind });
}

/**
 * At activation: open the request when the policy asks for one. A failure
 * here — no template published, the rail down — never undoes the
 * activation; it is logged and returned so the desk sees it, and the
 * Signatures desk can send the document by hand.
 */
export async function requestEngagementSignature(agentId: string, side: AgentSide, byUserId: string): Promise<{ opened: boolean; requestId: string | null; reason: string | null }> {
  try {
    const { request, created } = await openSigningRequest({ kind: ENGAGEMENT_KIND[side], partyType: 'AGENT', partyId: agentId, requestedById: byUserId });
    return { opened: created, requestId: request.id, reason: null };
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'SIGNING_NOT_OPEN') return { opened: false, requestId: null, reason: null };
    logger.error('Engagement terms: could not open the signing request', { agentId, side, err: cause });
    return { opened: false, requestId: null, reason: cause instanceof ApiError ? cause.message : 'The signing rail did not answer' };
  }
}
