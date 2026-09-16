import type {
  DisputeCreditStatus,
  DisputeOutcome,
  DisputeParty,
  DisputeReason,
  DisputeStatus,
} from '../../shared/database';
import type { Money } from '../../shared/money';

export type { DisputeCreditStatus, DisputeOutcome, DisputeParty, DisputeReason, DisputeStatus };

/** Who is asking: the token's subject and roles. */
export type Actor = { sub: string; roles: string[] };

export const DISPUTE_REASONS = ['PROOF_REJECTED', 'PAYOUT_ISSUE', 'DAMAGE', 'WRONG_LOCATION', 'OTHER'] as const;
export const DISPUTE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'AWAITING_RESPONSE', 'ESCALATED', 'RESOLVED', 'REJECTED'] as const;
export const DISPUTE_OUTCOMES = ['REINSTALL', 'PARTIAL_CREDIT', 'FULL_CREDIT', 'NO_FAULT'] as const;
/** Where ops may move a case by hand; closing goes through resolve. */
export const OPS_MOVABLE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'AWAITING_RESPONSE', 'ESCALATED'] as const;

/** How long ADX gives itself to answer a new case. */
export const SLA_HOURS = 72;
/** How long after a decision the raiser may reopen it. */
export const REOPEN_DAYS = 7;

/**
 * The agent's three chips are a projection of the six statuses, not a
 * different set — decision 1. Anything ADX is holding is "under review"
 * to the person waiting on it.
 */
export type AgentDisputeState = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED';

export function agentStateOf(status: DisputeStatus): AgentDisputeState {
  switch (status) {
    case 'OPEN':
      return 'OPEN';
    case 'RESOLVED':
    case 'REJECTED':
      return 'RESOLVED';
    default:
      return 'UNDER_REVIEW';
  }
}

export const isClosed = (status: DisputeStatus) => status === 'RESOLVED' || status === 'REJECTED';

export type NewDispute = {
  displayId: string;
  raisedByUserId: string;
  raisedAs: DisputeParty;
  againstParty: DisputeParty;
  againstUserId: string | null;
  orderId: string | null;
  listingId: string | null;
  reason: DisputeReason;
  detail: string;
  expectedResolution: string | null;
  amountClaimed: Money | null;
  slaDueAt: Date;
};

export type NewMessage = {
  disputeId: string;
  authorUserId: string;
  authorName: string;
  isFromOps: boolean;
  body: string;
};

export type NewEvidence = {
  disputeId: string;
  uploadedByUserId: string;
  url: string;
  kind: 'IMG' | 'PDF' | 'OTHER';
  fileName: string | null;
};

export type DisputePatch = Partial<{
  status: DisputeStatus;
  statusNote: string | null;
  /** Lot D (Q53/Q91): the clock, paused while AWAITING_RESPONSE. */
  slaDueAt: Date | null;
  slaPausedAt: Date | null;
  slaPausedMs: number;
  /** Lot D (Q54/Q92): the visit a REINSTALL raised. */
  reinstallMilestoneId: string | null;
  reviewStartedAt: Date | null;
  escalatedAt: Date | null;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  outcome: DisputeOutcome | null;
  resolutionNote: string | null;
  creditedAmount: Money | null;
  creditStatus: DisputeCreditStatus;
  creditReleasedAt: Date | null;
  creditReleasedById: string | null;
  creditWalletEntryId: string | null;
  reopenUntil: Date | null;
  resolutionRating: number | null;
  resolutionRatingNote: string | null;
  resolutionRatedAt: Date | null;
}>;

export type QueueFilter = {
  /** E6: several statuses at once, the way a chip row serialises. */
  status?: DisputeStatus[];
  /** E6: the display id, the detail or the order's campaign name — contains. */
  q?: string;
  limit: number;
  offset: number;
};

/** The parties an order names, as the raise needs them. */
export type OrderParties = {
  id: string;
  status: string;
  campaignName: string | null;
  listingId: string;
  listingTitle: string;
  advertiserUserId: string;
  publisherUserId: string | null;
  agentUserId: string | null;
};

/** The wallet-bearing records behind one login. */
export type PartyIds = {
  publisherId: string | null;
  advertiserId: string | null;
  agentId: string | null;
};

export type DisputeSummary = {
  open: number;
  valueAtRisk: Money;
  slaBreaches: number;
  avgResolutionDays: number;
  creditedThisMonth: Money;
  rejectedThisMonth: number;
};
