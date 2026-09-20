/**
 * The KYC queue state of a PARTY — Lot N3-B (the owner, 14 Sep 2026).
 *
 * "The moment a user creates an account or gets an account at ADX, their KYC
 * automatically becomes pending, hence they should be automatically appearing
 * in the KYC queue in their respective section." So the five queues list
 * parties, not records, and each party is in exactly one of six states,
 * derived here from the record it has (or has not) and the party's own
 * `kycStatus` mirror where it keeps one:
 *
 *   AWAITING_DOCUMENTS  no record yet, or a record with nothing submitted and
 *                       no request — the party just arrived
 *   REQUESTED           the desk asked (`requestedAt` set) and nothing is in
 *   PENDING             submitted, under review
 *   NEEDS_INFO          the desk asked for some tiles again
 *   REJECTED            decided against
 *   VERIFIED            decided for (a party whose mirror says VERIFIED with
 *                       no record — a legacy row — reads VERIFIED too)
 *
 * It lives in `shared` because both sides need it without a ring: the KYC
 * desks (`kyc`, `publishers/kyc`, `print-partners/kyc`) derive the queue
 * rows from it, and the party modules (`advertisers`, `agents`, `employees`
 * — which `kyc` imports, so they cannot import `kyc` back) put the same
 * `kyc: { state, ... }` summary on their party reads, so the party page and
 * the queue never disagree. The where fragments are structural — the four
 * columns they name (`status`, `submittedAt`, `requestedAt`, and the
 * party's `kycStatus`) are spelt the same on every KYC table — so each
 * Prisma repository spreads them into its own model's where clause.
 */
import { upperEnum } from '../validation';

export const KYC_QUEUE_STATES = ['AWAITING_DOCUMENTS', 'REQUESTED', 'PENDING', 'NEEDS_INFO', 'REJECTED', 'VERIFIED'] as const;
export type KycQueueState = (typeof KYC_QUEUE_STATES)[number];

/** `?state=` on the five queues; case-insensitive like every other facet. */
export const kycQueueStateSchema = upperEnum(KYC_QUEUE_STATES).optional();

/** The old `?status=` facet, kept as an alias: each record status names the state of the same word. */
export const KYC_STATUS_ALIASES = ['PENDING', 'VERIFIED', 'REJECTED', 'NEEDS_INFO'] as const;
export const kycStatusAliasSchema = upperEnum(KYC_STATUS_ALIASES).optional();

/** What the derivation reads off a record — every KYC table has these. */
export type KycStateRecord = {
  id: string;
  status: string;
  submittedAt: Date | null;
  requestedAt?: Date | null;
  requestedChannel?: string | null;
  method?: string | null;
};

/**
 * The state of a party from its record and (where the party keeps one) its
 * `kycStatus` mirror. A decided record is its decision; a PENDING record is
 * PENDING once something was submitted, REQUESTED once the desk asked, and
 * AWAITING_DOCUMENTS otherwise; no record is AWAITING_DOCUMENTS unless the
 * mirror already says VERIFIED.
 */
export function deriveKycState(record: KycStateRecord | null | undefined, partyKycStatus?: string | null): KycQueueState {
  if (!record) return partyKycStatus === 'VERIFIED' ? 'VERIFIED' : 'AWAITING_DOCUMENTS';
  switch (record.status) {
    case 'VERIFIED':
      return 'VERIFIED';
    case 'REJECTED':
      return 'REJECTED';
    case 'NEEDS_INFO':
      return 'NEEDS_INFO';
    default:
      if (record.submittedAt) return 'PENDING';
      if (record.requestedAt) return 'REQUESTED';
      return 'AWAITING_DOCUMENTS';
  }
}

/** The six facts every party read carries as `kyc`, so the party page and its queue row agree. */
export type KycSummary = {
  state: KycQueueState;
  kycId: string | null;
  submittedAt: Date | null;
  requestedAt: Date | null;
  requestedChannel: string | null;
  method: string | null;
};

export function kycSummaryOf(record: KycStateRecord | null | undefined, partyKycStatus?: string | null): KycSummary {
  return {
    state: deriveKycState(record, partyKycStatus),
    kycId: record?.id ?? null,
    submittedAt: record?.submittedAt ?? null,
    requestedAt: record?.requestedAt ?? null,
    requestedChannel: record?.requestedChannel ?? null,
    method: record?.method ?? null,
  };
}

/* ── where fragments ─────────────────────────────────────────────────────── */

/** A record-level where for one state — the columns every KYC table has. */
export type KycRecordStateWhere = {
  status?: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'NEEDS_INFO';
  submittedAt?: null | { not: null };
  requestedAt?: null | { not: null };
};

/** The record half of a state: what a record in that state looks like. */
export function kycRecordStateWhere(state: KycQueueState): KycRecordStateWhere {
  switch (state) {
    case 'AWAITING_DOCUMENTS':
      return { status: 'PENDING', submittedAt: null, requestedAt: null };
    case 'REQUESTED':
      return { status: 'PENDING', submittedAt: null, requestedAt: { not: null } };
    case 'PENDING':
      return { status: 'PENDING', submittedAt: { not: null } };
    case 'NEEDS_INFO':
      return { status: 'NEEDS_INFO' };
    case 'REJECTED':
      return { status: 'REJECTED' };
    case 'VERIFIED':
      return { status: 'VERIFIED' };
  }
}

/**
 * A party-level where fragment, over the party's `kyc` relation. `mirror`
 * says whether the party table keeps a `kycStatus` column (publishers,
 * advertisers, print partners do; agents and employees do not): a party
 * with no record and a VERIFIED mirror is not awaiting documents.
 */
export type KycPartyStateWhere = {
  kyc?: null | { is: KycRecordStateWhere } | { isNot: null };
  kycStatus?: { not: 'VERIFIED' };
  OR?: KycPartyStateWhere[];
};

export function kycPartyStateWhere(state: KycQueueState, mirror: boolean): KycPartyStateWhere {
  const record: KycPartyStateWhere = { kyc: { is: kycRecordStateWhere(state) } };
  if (state !== 'AWAITING_DOCUMENTS') return record;
  const none: KycPartyStateWhere = mirror ? { kyc: null, kycStatus: { not: 'VERIFIED' } } : { kyc: null };
  return { OR: [none, record] };
}

/**
 * Who is in a queue at all: every party whose mirror is not VERIFIED, plus
 * every party with a record (so the VERIFIED chip still lists the verified).
 * With no mirror, everyone.
 */
export function kycQueueBaseWhere(mirror: boolean): KycPartyStateWhere {
  return mirror ? { OR: [{ kycStatus: { not: 'VERIFIED' } }, { kyc: { isNot: null } }] } : {};
}

/** The six counts a queue answers as `counts`, plus the camel-cased `awaitingDocuments` the console's chip reads. */
export type KycStateCounts = Record<KycQueueState, number> & { awaitingDocuments: number };

export function kycStateCounts(counts: Partial<Record<KycQueueState, number>>): KycStateCounts {
  const filled = Object.fromEntries(KYC_QUEUE_STATES.map((state) => [state, counts[state] ?? 0])) as Record<KycQueueState, number>;
  return { ...filled, awaitingDocuments: filled.AWAITING_DOCUMENTS };
}

/** QR-3: how far along a publisher is, and the verified mark every party earns the same way. */
export * from './readiness';
