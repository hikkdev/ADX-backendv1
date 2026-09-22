import { ApiError } from '../../shared/errors';
import { findActivityByMetadata, logActivity } from '../../shared/audit';
import type { AccessGrantScope } from '../../shared/database';
import { deactivateQr, generateQr, listScansFor } from '../qr';
import { findAgentProfile, findWorkingAgentProfile } from '../agents';
import { prismaAccessGrantsRepository as repository } from './prisma-access-grants.repository';
import type { IssueGrantInput } from './access-grants.schema';
import type { GrantSubject } from './access-grants.repository';

/**
 * Delegated access: a publisher lending an agent a limited hand.
 *
 * The platform's default is that an agent acts for the publishers they
 * onboarded and nobody else. That default is load-bearing — an agent who can
 * edit any listing can reprice a competitor's spot, and since listings feed the
 * comparable pools, they can move the market a rival is measured against.
 *
 * This is the one exception, and every part of it is designed so the publisher
 * stays the one granting it:
 *
 *   1. The publisher raises a support ticket asking for help.
 *   2. ADX assigns an agent to that ticket.
 *   3. The publisher generates a QR *from their own app*, saying in their own
 *      words what they want changed, and is shown what the code hands over.
 *   4. The assigned agent scans it. The window starts then, not at generation.
 *   5. It closes by itself.
 *
 * Nobody in this flow can grant themselves access, and nothing here needs
 * anyone to remember to switch it off.
 */

/** Who is asking, and what they are allowed to be asking for. */
export type Actor = { userId: string; isAdmin: boolean };

export async function issueGrant(input: IssueGrantInput, actor: Actor) {
  const publisher = await repository.publisherFor(input.publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');

  // The publisher's own login, or ops acting on a ticket. An agent cannot mint
  // themselves a grant — that would be the whole mechanism arguing with itself.
  if (!actor.isAdmin && publisher.userId !== actor.userId) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Only the publisher can grant access to their own account'
    );
  }

  /**
   * The agent comes from the ticket, and from nowhere else.
   *
   * Three checks, each closing a different hole. The ticket has to exist. It has
   * to be *this publisher's* — otherwise a publisher could point at somebody
   * else's request and borrow the agent on it. And it has to have been assigned,
   * because an unassigned ticket names nobody and a grant with no agent is a
   * code anybody could claim.
   */
  const ticket = await repository.ticketFor(input.supportTicketId);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Support ticket not found');
  if (ticket.userId !== publisher.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'That support request is not on this account');
  }
  if (!ticket.assignedAgentId) {
    throw new ApiError(
      409,
      'CONFLICT',
      'ADX has not put anyone on this request yet. You will be able to grant access once they do.'
    );
  }
  const assignedAgentId = ticket.assignedAgentId;

  // A narrowed grant has to name listings this publisher actually owns, or the
  // narrowing is decoration: an id from somewhere else would sit in the array
  // looking like a restriction while granting nothing and hiding nothing.
  if (input.listingIds.length > 0) {
    const owned = new Set(await repository.listingIdsFor(input.publisherId));
    const foreign = input.listingIds.filter((id) => !owned.has(id));
    if (foreign.length > 0) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `Those listings do not belong to this publisher: ${foreign.join(', ')}`
      );
    }
  }

  const grant = await repository.create({
    publisherId: input.publisherId,
    reason: input.reason,
    scope: input.scope,
    listingIds: input.listingIds,
    assignedAgentId,
    supportTicketId: ticket.id,
    durationMinutes: input.durationMinutes,
  });

  // Locked to agent publishers at the QR layer as well as at the claim. Two
  // checks for one rule, because the QR layer is what an unrelated scanner
  // reaches first and it should refuse them there rather than at the far end.
  const { qrId, token } = await generateQr('ACCESS_GRANT', grant.id, ['AGENT_PUBLISHER'], {
    scope: grant.scope,
    reason: grant.reason,
  });
  await repository.attachQr(grant.id, qrId);

  await logActivity(actor.userId, 'ACCESS_GRANT_ISSUED', undefined, {
    grantId: grant.id,
    publisherId: grant.publisherId ?? '',
    assignedAgentId: grant.assignedAgentId,
    scope: grant.scope,
    listingIds: grant.listingIds,
    durationMinutes: grant.durationMinutes,
  });

  return { grant: { ...grant, qrId }, token };
}

/**
 * What the scanning agent is shown, and what the claim is checked against.
 *
 * Split into prepare and commit for the same reason publisher onboarding is:
 * the QR is burned and the grant claimed together, only after every check has
 * passed, so a refused scan never leaves a publisher holding a dead code.
 */
export type PreparedGrant = {
  grantId: string;
  publisherId: string;
  publisherName: string;
  reason: string;
  scope: AccessGrantScope;
  listingIds: string[];
  durationMinutes: number;
  expiresAt: Date;
};

export async function prepareGrantClaim(
  grantId: string,
  scannedByUserId: string
): Promise<PreparedGrant> {
  const grant = await repository.findById(grantId);
  if (!grant) throw new Error('QR_NOT_FOUND');

  // AG-1: an applicant, a held or an exited agent is not an agent to a scan.
  const agent = await findWorkingAgentProfile(scannedByUserId);
  // Sentinels rather than ApiErrors: the QR controller maps these to statuses,
  // and a scan that fails should read the same whichever code type it was.
  if (!agent) throw new Error('QR_ACCESS_DENIED');
  // The assignment is the point. A QR image forwarded to another agent is a
  // picture of a code they cannot use.
  if (agent.id !== grant.assignedAgentId) throw new Error('QR_ACCESS_DENIED');
  if (grant.status === 'REVOKED') throw new Error('QR_ACCESS_DENIED');
  if (grant.status !== 'PENDING') throw new Error('QR_ALREADY_CLAIMED');

  return {
    grantId: grant.id,
    publisherId: grant.publisherId ?? '',
    publisherName: grant.publisher?.name ?? '',
    reason: grant.reason,
    scope: grant.scope,
    listingIds: grant.listingIds,
    durationMinutes: grant.durationMinutes,
    expiresAt: new Date(Date.now() + grant.durationMinutes * 60_000),
  };
}

export async function commitGrantClaim(
  grantId: string,
  expiresAt: Date,
  scannedByUserId: string
): Promise<void> {
  await repository.claim(grantId, expiresAt);
  await logActivity(scannedByUserId, 'ACCESS_GRANT_CLAIMED', undefined, {
    grantId,
    expiresAt: expiresAt.toISOString(),
  });
}

export async function revokeGrant(grantId: string, actor: Actor) {
  const grant = await repository.findById(grantId);
  if (!grant) throw new ApiError(404, 'NOT_FOUND', 'Access grant not found');

  if (!actor.isAdmin && grant.publisher?.userId !== actor.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'Only the publisher or ADX can withdraw this');
  }
  if (grant.status === 'REVOKED' || grant.status === 'EXPIRED') return grant;

  // The code goes with it. A revoked grant whose QR still resolves would hand
  // the next scanner a claim on something that is no longer granted.
  if (grant.qrId) await deactivateQr(grant.qrId);

  const revoked = await repository.setStatus(grantId, 'REVOKED', {
    revokedAt: new Date(),
    revokedById: actor.userId,
  });
  await logActivity(actor.userId, 'ACCESS_GRANT_REVOKED', undefined, { grantId });
  return revoked;
}

/**
 * Does this agent currently hold access to this publisher, for this purpose?
 *
 * The question every guarded write asks. `listingId` narrows it: a grant that
 * named three listings covers those three and nothing else, and a grant that
 * named none covers all of them — which is why an empty array cannot be read as
 * "unspecified" anywhere in this file.
 */
export async function holdsLiveGrant(
  agentId: string,
  publisherId: string,
  scope: AccessGrantScope,
  listingId?: string,
  now: Date = new Date()
): Promise<boolean> {
  const grants = await repository.findLiveForAgent(agentId, { publisherId }, scope, now);
  return grants.some(
    (grant) =>
      grant.listingIds.length === 0 ||
      listingId === undefined ||
      grant.listingIds.includes(listingId)
  );
}

export async function listGrantsForPublisher(publisherId: string, actor: Actor) {
  const publisher = await repository.publisherFor(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (!actor.isAdmin && publisher.userId !== actor.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'That is not your account');
  }
  return repository.listForPublisher(publisherId);
}

export async function listGrantsForAgent(userId: string) {
  const agent = await findAgentProfile(userId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'You have no agent profile');
  return repository.listForAgent(agent.id);
}

/** AG-5: an exited agent's live grants — pending or active — are closed by ADX. Returns how many. */
export async function revokeLiveGrantsForAgent(agentId: string, actorUserId: string): Promise<number> {
  const grants = await repository.listForAgent(agentId);
  let revoked = 0;
  for (const grant of grants) {
    if (grant.status !== 'PENDING' && grant.status !== 'ACTIVE') continue;
    await revokeGrant(grant.id, { userId: actorUserId, isAdmin: true });
    revoked += 1;
  }
  return revoked;
}

/** Ops view: every grant still open, so nobody has to ask who has access. */
export async function listOpenGrants() {
  return repository.listOpen();
}

/**
 * The authority a door-to-door onboarding runs under.
 *
 * Opened when the person whose code it was approves the scan — not when the
 * agent scans — and separate from `Publisher.agentId`, which only records who
 * brought them in. Scoped to the profile, time-boxed to the onboarding
 * window, revocable like any grant, and closed when the onboarding is.
 */
export const ONBOARDING_GRANT_MINUTES = 48 * 60;

export async function openOnboardingGrant(input: {
  subject: GrantSubject;
  agentId: string;
  qrId: string;
}) {
  return repository.createOnboarding({
    subject: input.subject,
    assignedAgentId: input.agentId,
    qrId: input.qrId,
    durationMinutes: ONBOARDING_GRANT_MINUTES,
  });
}

/**
 * QR-27: the authority an approved access request opens — the owner said
 * yes to the agent in front of them, for what that agent asked (listings or
 * the profile) and for as long as they asked, a day at most. No ticket and
 * no pre-assignment: the scan is the request and the approval is the
 * assignment. Revocable like any grant, listed in the owner's access log.
 */
export async function openRequestedGrant(input: {
  subject: GrantSubject;
  agentId: string;
  /** The agent's login, for the audit row. */
  scannedByUserId: string;
  ask: { scope: AccessGrantScope; reason: string; durationMinutes: number };
}) {
  const durationMinutes = Math.min(Math.max(input.ask.durationMinutes, 15), 24 * 60);
  const grant = await repository.createRequested({
    subject: input.subject,
    assignedAgentId: input.agentId,
    scope: input.ask.scope,
    reason: input.ask.reason.trim() || 'Asked for at the door',
    durationMinutes,
  });
  await logActivity(input.scannedByUserId, 'ACCESS_GRANT_ISSUED', undefined, {
    grantId: grant.id,
    publisherId: 'publisherId' in input.subject ? input.subject.publisherId : '',
    advertiserId: 'advertiserId' in input.subject ? input.subject.advertiserId : '',
    assignedAgentId: input.agentId,
    scope: grant.scope,
    durationMinutes,
    requested: true,
  });
  return grant;
}

export async function closeOnboardingGrants(subject: GrantSubject): Promise<number> {
  return repository.expireOnboarding(subject, new Date());
}

/** Whether an agent is mid-way through onboarding this account. */
export async function hasLiveOnboardingGrant(subject: GrantSubject): Promise<boolean> {
  return (await repository.findLiveOnboarding(subject, new Date())) !== null;
}

/** The live grant itself, for a write that has to record which one it ran under. */
export async function liveGrantFor(
  agentId: string,
  subject: GrantSubject,
  scope: AccessGrantScope,
  now: Date = new Date()
) {
  const grants = await repository.findLiveForAgent(agentId, subject, scope, now);
  return grants[0] ?? null;
}

/* ── U9: the owner's own record of who has had access ─────────────────────── */

export type AccessLogView = {
  /** Every scan of the account's door-to-door codes, refusals included. */
  scans: {
    id: string;
    at: Date;
    outcome: string;
    distanceM: number | null;
    decidedAt: Date | null;
    agent: { name: string | null; displayId: string | null; mobile: string };
  }[];
  /** Every authority ever opened on the account, and how it ended. */
  grants: {
    id: string;
    purpose: string;
    scope: string;
    status: string;
    from: Date | null;
    until: Date | null;
    revokedAt: Date | null;
  }[];
  /** Every write an agent made under one of those authorities. */
  changes: {
    id: string;
    at: Date;
    action: string;
    fields: string[];
    grantId: string | null;
    by: { name: string | null };
  }[];
};

/**
 * What the door-to-door model promised: exactly which agent did what, and
 * when. Three sources, one answer, composed here because this module owns
 * the authority and already reads the codes; the party modules hand in their
 * subject. Advertiser-side writes are not yet gated on a grant, so their
 * `changes` are empty until they are — the list is honest, not padded.
 */
/** K-B1: `{ id, label, displayId }` per grant id, one query — the QR desk names an ACCESS_GRANT code's grant with it. */
export const findAccessGrantLabels = (ids: readonly string[]) => repository.findLabelsByIds([...new Set(ids)]);

export async function accessLogFor(subject: GrantSubject): Promise<AccessLogView> {
  const side =
    'publisherId' in subject
      ? {
          type: 'PUBLISHER' as const,
          id: subject.publisherId,
          key: 'publisherId',
          actions: ['PUBLISHER_UPDATED_UNDER_GRANT', 'PUBLISHER_KYC_SUBMITTED_UNDER_GRANT'],
        }
      : {
          type: 'ADVERTISER' as const,
          id: subject.advertiserId,
          key: 'advertiserId',
          actions: [
            'ADVERTISER_UPDATED_UNDER_GRANT',
            'ADVERTISER_KYC_SUBMITTED_UNDER_GRANT',
            // What the attributed agent did under the grant — advertisers.policy logs these.
            'ADVERTISER_PROFILE_UPDATED',
            'ADVERTISER_AGREEMENT_ACCEPTED',
            'ADVERTISER_INSERTION_ORDER_ACCEPTED',
            'ADVERTISER_BRAND_CREATED',
            'ADVERTISER_BRAND_UPDATED',
            'ADVERTISER_HOLD_PLACED',
            'ADVERTISER_HOLD_RELEASED',
          ],
        };

  const [scans, grants, changes] = await Promise.all([
    listScansFor(side.type, side.id),
    repository.listForSubject(subject),
    findActivityByMetadata(side.actions, side.key, side.id),
  ]);

  return {
    scans: scans.map((scan) => ({
      id: scan.id,
      at: scan.createdAt,
      outcome: scan.outcome,
      distanceM: scan.distanceM,
      decidedAt: scan.decidedAt,
      agent: {
        name: scan.scannedBy.name,
        displayId: scan.scannedBy.agentProfile?.displayId ?? null,
        mobile: scan.scannedBy.mobile,
      },
    })),
    grants: grants.map((grant) => ({
      id: grant.id,
      purpose: grant.purpose,
      scope: grant.scope,
      status: grant.status,
      from: grant.claimedAt ?? grant.createdAt ?? null,
      until: grant.expiresAt,
      revokedAt: grant.revokedAt,
    })),
    changes: changes.map((entry) => {
      const meta = (entry.metadata ?? {}) as { fields?: unknown; grantId?: unknown };
      return {
        id: entry.id,
        at: entry.createdAt,
        action: entry.action,
        fields: Array.isArray(meta.fields) ? meta.fields.map(String) : [],
        grantId: typeof meta.grantId === 'string' ? meta.grantId : null,
        by: { name: entry.user.name },
      };
    }),
  };
}

/* ── D6: ops oversight ───────────────────────────────────────────────────── */

/** Every grant an agent has ever held, with the party named. ADMIN only, by route. */
export async function listGrantsHeldByAgent(agentId: string) {
  return repository.listForAgentWithNames(agentId);
}

/** A party's whole record by type and id — the owner's log, read by ops. */
export async function partyAccessLog(partyType: 'publisher' | 'advertiser', partyId: string): Promise<AccessLogView> {
  if (partyType === 'publisher') return accessLogFor({ publisherId: partyId });
  if (partyType === 'advertiser') return accessLogFor({ advertiserId: partyId });
  throw new ApiError(400, 'VALIDATION_ERROR', 'partyType must be publisher or advertiser');
}
