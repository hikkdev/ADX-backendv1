import { logger } from '../../../shared/logging';
import { ApiError } from '../../../shared/errors';
import type { DigioWebhookPayload } from '../../../shared/integrations/digio-client';
import { workflowKeyFor } from '../../../shared/integrations/digio-workflows';
import {
  digioAnswerOf,
  hostedProviderName,
  hostedProviderOf,
  isDigioRequestOpen,
  partyKycAnswer,
  startPartyKyc,
  type BackupCasePort,
  type PartyKycAnswer,
} from '../../../shared/verification';
import { digioDecisionOf, isStaleDigioCallback } from '../../../shared/integrations/digio-callback';
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

/**
 * The Digio start as the desk has always had it. Asked through the
 * verification router (the attempt is on record; with the backup ON a
 * technical failure marks the record PROVIDER_FAILED), and answered exactly
 * as before.
 */
export async function initiateAgentDigioKyc(
  agent: AgentContact,
  opts: { onBehalf: boolean } = { onBehalf: true },
  now = new Date(),
): Promise<DigioSession> {
  return digioAnswerOf(await startAgentKyc(agent, { onBehalf: opts.onBehalf }, now));
}

/**
 * The agent's KYC start. Digio first; a Cashfree session in its place only
 * for the agent's own start (`onBehalf: false`) from a client that supports
 * it (`supports` names CASHFREE), with the backup switched ON, when Digio
 * could not be asked and no Digio request is already out. An agent's
 * Cashfree steps add the driving licence and the vehicle RC.
 */
export async function startAgentKyc(
  agent: AgentContact,
  opts: { onBehalf: boolean; supports?: readonly string[] | undefined } = { onBehalf: true },
  now = new Date(),
): Promise<PartyKycAnswer> {
  const current = await repository.findByAgentId(agent.id);
  if (current?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This agent is already verified; there is nothing to start');
  }
  const referenceId = `${DIGIO_REFERENCE_PREFIX}${agent.id}-${now.getTime()}`;
  const customerName = agent.user.name ?? agent.displayId ?? agent.id;
  const started = await startPartyKyc(
    {
      caseType: 'AGENT_KYC',
      caseId: agent.id,
      digio: {
        party: 'AGENT',
        // Phase D (the owner, 1 Oct 2026): field and sales agents verify on the one agent workflow.
        workflowKey: workflowKeyFor({ party: 'AGENT' }),
        referenceId,
        customerName,
        customerEmail: agent.user.email ?? '',
        customerMobile: agent.user.mobile,
      },
      supports: opts.supports,
      origin: opts.onBehalf ? 'DESK' : 'SELF',
      digioRequestOpen: isDigioRequestOpen(current),
      ownerUserId: agent.userId,
      subject: { name: customerName, party: 'AGENT', business: false },
      markProviderFailed: () => repository.markProviderFailed(agent.id),
    },
    now,
  );
  await repository.upsertDigio(agent.id, {
    method: started.provider,
    digioRequestId: started.requestId,
    digioReferenceId: referenceId,
    digioStatus: 'pending',
    ...(opts.onBehalf ? {} : { submittedAt: now }),
  });
  return partyKycAnswer(started, opts.supports);
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

  const decision = digioDecisionOf(payload.status);
  const approved = decision === 'VERIFIED';
  const rejected = decision === 'REJECTED';
  const completedAt = payload.completed_at ? new Date(payload.completed_at) : undefined;

  // Phase D: a late or unknown status never un-decides the record (`digio-callback.ts`).
  if (isStaleDigioCallback(row.status, decision)) {
    logger.info('Digio webhook left a decided agent record as it was', { kycId: payload.id, status: payload.status, recordStatus: row.status });
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
          ? `${verifier} has verified your identity.`
          : `${verifier} could not verify you. ${payload.message ?? 'You can try again, or come to the desk with your documents.'}`,
        suggestedAction: approved ? 'Open your profile' : 'Open KYC',
        relatedId: row.id,
      },
    },
  );
  return true;
}

/**
 * Cashfree Phase 1: an agent's KYC case, for the desk's "Resend on backup"
 * (registered as `AGENT_KYC`, keyed by the agent profile id). Like the
 * desk's Digio request, `submittedAt` is left for the outcome.
 */
export const agentBackupCase: BackupCasePort = {
  async load(agentId) {
    const agent = await repository.findAgentContact(agentId);
    if (!agent) return null;
    const record = await repository.findByAgentId(agentId);
    return {
      ownerUserId: agent.userId,
      subject: { name: agent.user.name ?? agent.displayId ?? agent.id, party: 'AGENT', business: false },
      workflowKey: workflowKeyFor({ party: 'AGENT' }),
      verified: record?.status === 'VERIFIED',
    };
  },
  stamp(agentId, fields) {
    const { at: _at, ...columns } = fields;
    return repository.upsertDigio(agentId, columns);
  },
};
