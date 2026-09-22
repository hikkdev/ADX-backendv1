import type { Request } from 'express';
import { ApiError } from '../../../shared/errors';
import { auditDiff, logActivity } from '../../../shared/audit';
import type { KycStatus } from '../../../shared/database';
import { kycStateCounts } from '../../../shared/kyc-state';
import { agentExists, findAgentProfile, upsertDocumentsFromKyc } from '../../agents';
import { notify } from '../../notifications';
import { kycChannelLabel, pageMeta, type KycRequestInput } from '../kyc.schema';
import { kycCaseExtras } from '../case-read';
import { agentDigioStatus, initiateAgentDigioKyc } from './agent-digio.service';
import { prismaAgentKycRepository as repository } from './prisma-agent-kyc.repository';
import type { AgentKycFilter } from './agent-kyc.repository';
import type { AgentKycDocuments } from './agent-kyc.schema';

/**
 * D4 — an agent's own KYC.
 *
 * Agents never self-serve: they are onboarded at ADX's desk and only ever
 * sign in. So the documents are recorded ON THEIR BEHALF by the admin who
 * met them, and the record remembers who that was. The review is the same
 * decision every other KYC row gets; the agent can read their own status.
 * N3-B: every agent is in the queue from the moment the profile exists
 * (AWAITING_DOCUMENTS), and the desk can ask them for their KYC with one
 * click — a Digio session on their behalf.
 */

/** The deep link a KYC_REQUESTED push opens for an agent: their KYC status screen in the agent app. */
export const AGENT_KYC_DEEP_LINK = 'adx://agent/kyc';

/**
 * `GET /agent-kyc` — N3-B: every agent, left-joined to their record, in one
 * of six states; `meta.counts` is agents per state over the filter with the
 * state facet removed.
 */
export async function listAgentKycs(where: AgentKycFilter, page: number, pageSize: number) {
  const [{ items, total }, counts] = await Promise.all([repository.findPage(where, page, pageSize), repository.countByState({ ...where, state: undefined, status: undefined })]);
  return { items, meta: { ...pageMeta(page, pageSize, total), counts: kycStateCounts(counts) } };
}

/** The desk's case read (ADMIN): the row and, E7-3, its age against the SLA with the reviewer and recorder by name. */
export async function getAgentKyc(agentId: string, now = new Date()) {
  const kyc = await repository.findByAgentId(agentId);
  if (!kyc) throw new ApiError(404, 'NOT_FOUND', 'No KYC recorded for this agent');
  return { ...kyc, ...(await kycCaseExtras(kyc, now)) };
}

/** The agent reading their own record. Null when nothing is recorded yet. */
export async function getMyAgentKyc(userId: string) {
  const agent = await findAgentProfile(userId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  return repository.findByAgentId(agent.id);
}

/** KYC-D: the agent starts Digio from their own phone — the primary path; the papers are the fallback. */
export async function initiateMyAgentDigioKyc(userId: string, now = new Date()) {
  const profile = await findAgentProfile(userId);
  if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  const agent = await repository.findAgentContact(profile.id);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  return initiateAgentDigioKyc(agent, { onBehalf: false }, now);
}

export async function myAgentDigioStatus(userId: string) {
  const profile = await findAgentProfile(userId);
  if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  return agentDigioStatus(profile.id);
}

/**
 * Recording is an upsert: ops can record what they have and come back for
 * the rest, and a fresh recording after a rejection sends the record back
 * to PENDING with the reason cleared. The recorder is written every time.
 */
export async function recordAgentKyc(agentId: string, data: AgentKycDocuments, recordedById: string) {
  if (!(await agentExists(agentId))) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  const recorded = await repository.record(agentId, data, recordedById);
  // AG-1: the same papers land in the application's document table, so the ladder and this desk agree.
  await upsertDocumentsFromKyc(agentId, data, recordedById).catch(() => undefined);
  return recorded;
}

/**
 * AG-1: an applicant filed an identity paper in the app — it is written onto
 * the desk's KYC record (the slot, PENDING, submitted now, recorded via APP)
 * so the KYC queue sees it. Registered on the application port by bootstrap.
 */
export async function mirrorAgentIdentityDocument(agentId: string, userId: string, kind: string, url: string, number: string | null): Promise<void> {
  const slot: AgentKycDocuments =
    kind === 'AADHAAR_FRONT' ? { govIdType: 'AADHAAR', govIdFrontUrl: url }
    : kind === 'AADHAAR_BACK' ? { govIdType: 'AADHAAR', govIdBackUrl: url }
    : kind === 'PAN' ? { panFrontUrl: url, ...(number && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(number.toUpperCase()) ? { panNumber: number.toUpperCase() } : {}) }
    : kind === 'SELFIE' ? { selfieUrl: url }
    : kind === 'ADDRESS_PROOF' ? { addressProofUrl: url }
    : kind === 'BANK_PROOF' ? { bankProofUrl: url }
    : {};
  if (Object.keys(slot).length === 0) return;
  await repository.recordFromApp(agentId, slot, userId);
}

export async function reviewAgentKyc(agentId: string, status: KycStatus, rejectionReason: string | undefined, reviewedById: string) {
  await getAgentKyc(agentId);
  if (status === 'REJECTED' && !rejectionReason?.trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the record is rejected');
  }
  return repository.review(agentId, status, rejectionReason?.trim() ?? null, reviewedById);
}

/* ── N3-B: the one click ─────────────────────────────────────────────────── */

/**
 * `POST /agent-kyc/:agentId/request { channel = DIGIO, note? }` — the desk
 * asks the agent for their KYC, beside the three parties' request routes.
 * DIGIO opens a Digio session on the agent's behalf (the same client, the
 * `adx-agt-` reference, the webhook landing on the agent's record);
 * MANUAL only tells them. Either way the row is made if there is none and
 * stamped (who, when, which channel; the status untouched — REQUESTED is
 * derived), the agent is told by `KYC_REQUESTED` (email, SMS, a push that
 * opens their KYC screen), and `AGENT_KYC_REQUESTED` is audited. 404 for an
 * agent that is not there; 409 `KYC_ALREADY_VERIFIED` once verified.
 */
export async function requestAgentKyc(agentId: string, input: KycRequestInput, byUserId: string, req?: Request, now = new Date()) {
  const agent = await repository.findAgentContact(agentId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent not found');
  const current = await repository.findByAgentId(agentId);
  if (current?.status === 'VERIFIED') {
    throw new ApiError(409, 'KYC_ALREADY_VERIFIED', 'This agent is already verified; there is nothing to request');
  }

  const digio = input.channel === 'DIGIO' ? await initiateAgentDigioKyc(agent, { onBehalf: true }, now) : null;
  const kyc = await repository.requestKyc(agentId, { requestedById: byUserId, requestedChannel: input.channel, at: now });

  await logActivity(byUserId, 'AGENT_KYC_REQUESTED', {
    req,
    targetType: 'AgentKyc',
    targetId: kyc.id,
    module: 'kyc',
    diff: auditDiff(current ?? {}, kyc, ['requestedAt', 'requestedChannel', 'method']),
    metadata: { agentId, channel: input.channel, note: input.note ?? null, digioKycId: digio?.kycId ?? null },
  });

  const partyName = agent.user.name ?? agent.displayId ?? 'there';
  await notify(
    'KYC_REQUESTED',
    agent.userId,
    { partyName, channel: kycChannelLabel(input.channel), note: input.note ?? '', deepLink: AGENT_KYC_DEEP_LINK },
    {
      inApp: {
        type: 'KYC',
        title: 'Please complete your verification',
        message:
          input.channel === 'DIGIO'
            ? `ADX has started a Digio identity check for you. Finish it from the link Digio sent — it takes about a minute. ${input.note ?? ''}`.trim()
            : `ADX has asked you to complete your identity verification at the desk. ${input.note ?? ''}`.trim(),
        suggestedAction: 'Verify your identity',
        relatedId: kyc.id,
      },
    },
  );

  return { kyc, digio: digio ? { kycId: digio.kycId, validTill: digio.validTill } : null, notified: true };
}
