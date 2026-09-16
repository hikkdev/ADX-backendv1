import type { Request } from 'express';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { logger } from '../../shared/logging';
import type { KycEscalationSource } from '../../shared/database';
import { findRoleMemberUserIds } from '../access-control';
import { getPlatformSettings } from '../app-config';
import { createNotification } from '../notifications';
import { prismaKycEscalationRepository as repository } from './prisma-kyc-escalation.repository';
import type { EscalatableCase, KycEscalationParty } from './escalation.repository';

/**
 * KYC escalation — Lot G (Q127/142).
 *
 * A case is escalated from three places and lands in one: on the row
 * (`escalatedAt`, `escalationSource`, `escalationReason`, `escalatedToUserId`,
 * `escalatedById`), with a member of the Compliance pool named and told, an
 * audit row `KYC_ESCALATED`, and the queue's `?escalated=true` filter and
 * `escalated` count picking it up. The three sources:
 *
 *   AGE         `jobs/kyc-escalation.job.ts`, nightly — PENDING for longer
 *               than `kyc.escalationSlaMultiplier` × `kyc.reviewSlaHours`,
 *               on all three queues (Lot N: the print partner's too).
 *   FRAUD_LINK  `fraud.openCaseRecord` — a fraud case opened against a party
 *               whose KYC is still PENDING.
 *   REVIEWER    `POST /publishers/kyc-queue/:publisherId/escalate`,
 *               `POST /advertiser-kyc/:id/escalate { reason }` and (Lot N)
 *               `POST /print-partner-kyc/:id/escalate`.
 *
 * Escalation is a flag on a pending case, not a status: the desk decides it
 * as before, and the decision clears the flag (each desk's `review` write
 * nulls the five columns). Once is enough — a case already escalated is left
 * as it is by the job and the fraud link, and refused 409 to a reviewer.
 *
 * The pool: the console role named **Compliance**, if an organisation has
 * made one; else the seeded **KYC reviewer** (the closest of the six the
 * console ships with — it is the role with KYC sign-off); else **Super
 * admin**; else any ADMIN. The escalating reviewer is never picked for their
 * own case while somebody else is in the pool. `kyc` cannot read `users`
 * (it sits above this module), so the ADMIN fallback is this module's own
 * read of the role table.
 */

/** In order: the role an organisation names for it, then the seeded roles that hold KYC sign-off. */
export const ESCALATION_ROLE_NAMES = ['Compliance', 'KYC reviewer', 'Super admin'] as const;

export type KycEscalationTarget =
  | { party: 'PUBLISHER'; publisherId: string }
  | { party: 'ADVERTISER'; kycId: string }
  /** Lot N: the print partner's desk, `POST /print-partner-kyc/:id/escalate`. */
  | { party: 'PRINT_PARTNER'; kycId: string };

export type KycEscalationInput = {
  source: KycEscalationSource;
  reason: string;
  /** The person (or the system user for the job) the audit row is written under; null when nobody is known. */
  byUserId: string | null;
  req?: Request | undefined;
};

export type KycEscalation = {
  party: KycEscalationParty;
  kycId: string;
  partyId: string;
  escalatedAt: Date;
  escalationSource: KycEscalationSource;
  escalationReason: string;
  escalatedToUserId: string | null;
  escalatedById: string | null;
};

/** A stable pick over the pool so the same case lands on the same person on a retry, and the pool shares the load. */
function pickFrom(pool: string[], key: string): string | null {
  if (pool.length === 0) return null;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return pool[hash % pool.length] ?? null;
}

/**
 * Who the case goes to: the first non-empty pool, minus the person
 * escalating; the ADMIN list when every role is empty. Null only when the
 * platform has no admin at all.
 */
export async function resolveEscalatee(caseKey: string, exclude: string | null): Promise<string | null> {
  const pools: string[][] = [];
  for (const name of ESCALATION_ROLE_NAMES) {
    const members = await findRoleMemberUserIds(name).catch(() => [] as string[]);
    if (members.length) pools.push(members);
  }
  pools.push(await repository.adminUserIds().catch(() => [] as string[]));
  for (const pool of pools) {
    const others = pool.filter((id) => id !== exclude);
    if (others.length) return pickFrom(others, caseKey);
  }
  // Only the escalating person exists anywhere — the case still needs a name on it.
  for (const pool of pools) if (pool.length) return pickFrom(pool, caseKey);
  return null;
}

async function loadCase(target: KycEscalationTarget): Promise<EscalatableCase> {
  const row =
    target.party === 'PUBLISHER'
      ? await repository.findPublisherCase(target.publisherId)
      : target.party === 'PRINT_PARTNER'
        ? await repository.findPrintPartnerCaseById(target.kycId)
        : await repository.findAdvertiserCaseById(target.kycId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', target.party === 'PUBLISHER' ? 'This publisher has no KYC record yet' : 'KYC not found');
  return row;
}

const isOpen = (status: string) => status === 'PENDING' || status === 'NEEDS_INFO';

/**
 * The escalation itself. A reviewer's is strict — a decided case answers 409,
 * an escalated one 409; the job's and the fraud link's are idempotent and
 * answer null where there is nothing to do.
 */
export async function escalateKycCase(row: EscalatableCase, input: KycEscalationInput, now = new Date()): Promise<KycEscalation | null> {
  const strict = input.source === 'REVIEWER';
  if (!isOpen(row.status)) {
    if (strict) throw new ApiError(409, 'CONFLICT', 'This case has been decided; there is nothing to escalate');
    return null;
  }
  if (row.escalatedAt) {
    if (strict) throw new ApiError(409, 'CONFLICT', 'This case is already escalated');
    return null;
  }
  const escalatedToUserId = await resolveEscalatee(row.kycId, input.byUserId);
  const stamp = {
    escalatedAt: now,
    escalationSource: input.source,
    escalationReason: input.reason,
    escalatedToUserId,
    escalatedById: input.byUserId,
  };
  await repository.markEscalated(row.party, row.kycId, stamp);

  if (input.byUserId) {
    await logActivity(input.byUserId, 'KYC_ESCALATED', {
      req: input.req,
      module: 'kyc',
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: { party: row.party, kycId: row.kycId, partyId: row.partyId, source: input.source, reason: input.reason, escalatedToUserId },
    });
  }

  if (escalatedToUserId && escalatedToUserId !== input.byUserId) {
    await createNotification({
      userId: escalatedToUserId,
      type: 'KYC',
      title: `KYC case escalated to you (${input.source.replace(/_/g, ' ').toLowerCase()})`,
      subtitle: row.partyName ?? undefined,
      message: input.reason.length > 200 ? `${input.reason.slice(0, 199)}…` : input.reason,
      suggestedAction: 'Open the KYC queue',
      relatedId: row.partyId,
      // Lot N: the apps open a publisher or an advertiser by id; a print partner is not a screen they open.
      ...(row.party === 'PRINT_PARTNER' ? {} : { relatedType: row.party }),
    }).catch((err: unknown) => logger.warn('KYC escalation notice not delivered', { kycId: row.kycId, reason: err instanceof Error ? err.message : String(err) }));
  }

  return { party: row.party, kycId: row.kycId, partyId: row.partyId, ...stamp };
}

/** REVIEWER: the desk's own button, on either queue. */
export async function escalateKyc(target: KycEscalationTarget, input: { reason: string; byUserId: string; req?: Request | undefined }, now = new Date()): Promise<KycEscalation> {
  const row = await loadCase(target);
  const result = await escalateKycCase(row, { source: 'REVIEWER', reason: input.reason, byUserId: input.byUserId, req: input.req }, now);
  // The strict path throws rather than answering null.
  return result as KycEscalation;
}

/**
 * FRAUD_LINK: `fraud` tells this module a case was opened against a party.
 * A LISTING resolves to its publisher; an AGENT has no escalatable KYC row.
 * Null when the party has no pending case, or it is already escalated.
 */
export async function escalateKycForFraudLink(input: {
  subjectType: 'LISTING' | 'PUBLISHER' | 'ADVERTISER' | 'AGENT';
  subjectId: string;
  caseDisplayId: string;
  byUserId: string;
}, now = new Date()): Promise<KycEscalation | null> {
  const row =
    input.subjectType === 'PUBLISHER'
      ? await repository.findPublisherCase(input.subjectId)
      : input.subjectType === 'LISTING'
        ? await repository.findPublisherCaseByListing(input.subjectId)
        : input.subjectType === 'ADVERTISER'
          ? await repository.findAdvertiserCaseByAdvertiserId(input.subjectId)
          : null;
  if (!row || row.status !== 'PENDING') return null;
  return escalateKycCase(row, { source: 'FRAUD_LINK', reason: `Fraud case ${input.caseDisplayId} opened against this party while KYC is pending`, byUserId: input.byUserId }, now);
}

/** What the nightly job reports. */
export type AgedEscalationReport = { cutoff: Date; slaHours: number; multiplier: number; publishers: string[]; advertisers: string[]; printPartners: string[] };

/**
 * AGE: every PENDING case older than the multiplier × the review SLA, not
 * yet escalated, on both queues. Bounded per run; the next night takes the
 * rest.
 */
export async function escalateAgedKycCases(actorUserId: string | null, now = new Date(), limit = 200): Promise<AgedEscalationReport> {
  const { kyc } = await getPlatformSettings();
  const hours = kyc.reviewSlaHours * kyc.escalationSlaMultiplier;
  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const reason = `Pending for over ${kyc.escalationSlaMultiplier}× the ${kyc.reviewSlaHours} h review SLA`;
  const report: AgedEscalationReport = { cutoff, slaHours: kyc.reviewSlaHours, multiplier: kyc.escalationSlaMultiplier, publishers: [], advertisers: [], printPartners: [] };
  // Lot N: the print partner's queue walks the same night.
  const buckets = { PUBLISHER: report.publishers, ADVERTISER: report.advertisers, PRINT_PARTNER: report.printPartners } as const;
  for (const party of ['PUBLISHER', 'ADVERTISER', 'PRINT_PARTNER'] as const) {
    const rows = await repository.findAgedPending(party, cutoff, limit);
    for (const row of rows) {
      const result = await escalateKycCase(row, { source: 'AGE', reason, byUserId: actorUserId }, now);
      if (result) buckets[party].push(row.kycId);
    }
  }
  return report;
}
