import { logger } from '../../../shared/logging';
import { ApiError } from '../../../shared/errors';
import { requestDigioKyc, type DigioWebhookPayload } from '../../../shared/integrations/digio-client';
import { notify } from '../../notifications';
import { prismaAgentKycRepository as repository } from './prisma-agent-kyc.repository';
import type { AgentContact } from './agent-kyc.repository';

/**
 * KYC by Digio for an agent — N3-B (the owner, 14 Sep 2026: "ADX Admin /
 * Super Admin ... should be able to send a Digio KYC request to the user
 * with click of a button" — every party, agents included).
 *
 * Agents are individuals with a user, so the session is the same request
 * the publisher's, the advertiser's and the print partner's make through
 * `shared/integrations/digio-client`, the customer being the agent's own
 * name, email and mobile, recorded on the agent's row. The reference ADX
 * hands Digio is `adx-agt-<agentId>-<ts>`; the webhook is routed the way
 * every party's is — by the request id Digio minted: ADX has one callback,
 * owned by `publishers`, and a request id no publisher row claims is
 * offered to the handlers registered at boot; `handleAgentDigioWebhook` is
 * one of them (`bootstrap/register-modules`).
 *
 * The desk opens a session (`POST /agent-kyc/:agentId/request`, channel
 * DIGIO — the default) and, since KYC-D (the owner, 21 Sep 2026: "KYC by
 * Digio for agents too; documents as the last resort for everyone"), so does
 * the agent from their own phone (`POST /agent-kyc/me/digio/initiate`). An
 * approval verifies the identity the application ladder asks for; the
 * paper uploads remain the way through when Digio cannot be used. On the
 * desk's request `submittedAt` is left for the webhook, so the queue reads
 * REQUESTED until Digio answers; the agent's own start stamps it.
 */

export const DIGIO_REFERENCE_PREFIX = 'adx-agt-';

export type DigioSession = { kycId: string; accessToken: string; validTill: string; sdkUrl: string };

export async function initiateAgentDigioKyc(
  agent: AgentContact,
  opts: { onBehalf: boolean } = { onBehalf: true },
  now = new Date(),
): Promise<DigioSession> {
  const current = await repository.findByAgentId(agent.id);
  if (current?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This agent is already verified; there is nothing to start');
  }
  const referenceId = `${DIGIO_REFERENCE_PREFIX}${agent.id}-${now.getTime()}`;
  const session = await requestDigioKyc({
    referenceId,
    customerName: agent.user.name ?? agent.displayId ?? agent.id,
    customerEmail: agent.user.email ?? '',
    customerMobile: agent.user.mobile,
  });
  await repository.upsertDigio(agent.id, {
    method: 'DIGIO',
    digioRequestId: session.kycId,
    digioReferenceId: referenceId,
    digioStatus: 'pending',
    ...(opts.onBehalf ? {} : { submittedAt: now }),
  });
  return { kycId: session.kycId, accessToken: session.accessToken, validTill: session.validTill, sdkUrl: session.sdkUrl };
}

/** KYC-D: what the agent's phone polls after starting Digio — what ADX has heard; null before any record. */
export async function agentDigioStatus(agentId: string): Promise<{ method: string; digioStatus: string | null; kycStatus: string; digioVerifiedAt: Date | null } | null> {
  const row = await repository.findByAgentId(agentId);
  if (!row) return null;
  return { method: row.method, digioStatus: row.digioStatus, kycStatus: row.status, digioVerifiedAt: row.digioVerifiedAt };
}

/**
 * Claims a webhook whose request id is an agent's; false when it is not.
 * The decision lands on the row (`recordedVia` DIGIO, `method` DIGIO on an
 * approval, `submittedAt` stamped where the desk's request left it empty)
 * and the agent is told through `KYC_DECISION`.
 */
export async function handleAgentDigioWebhook(payload: DigioWebhookPayload, now = new Date()): Promise<boolean> {
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

  logger.info('Digio webhook applied to an agent', { kycId: payload.id, status: payload.status, agentId: row.agentId });

  if (decision === 'PENDING') return true;

  await notify(
    'KYC_DECISION',
    row.agent.userId,
    {
      partyName: row.agent.user.name ?? row.agent.displayId ?? 'there',
      decision: approved ? 'verified' : 'not verified',
      reason: approved ? 'You can be paid out once the rest of your setup is done.' : (payload.message ?? 'You can try again, or come to the desk with your documents.'),
    },
    {
      inApp: {
        type: 'KYC',
        title: approved ? 'Identity verified' : 'Identity check did not clear',
        message: approved
          ? 'Digio has verified your identity.'
          : `Digio could not verify you. ${payload.message ?? 'You can try again, or come to the desk with your documents.'}`,
        suggestedAction: approved ? 'Open your profile' : 'Open KYC',
        relatedId: row.id,
      },
    },
  );
  return true;
}
