import { money, Decimal, type Money } from '../../shared/money';
import { accountStateOf, type AccountState } from '../../shared/party-status';
import type { CreativeStatus, KycStatus } from '../../shared/database';
import {
  AGENT_WAITING_ORDER_STATUSES,
  PUBLISHER_WAITING_ORDER_STATUSES,
  type CampaignAdvertiserRow,
  type CampaignGateFacts,
  type CampaignPerformanceTotals,
} from './campaigns.repository';
import { WAITING_REASONS, type WaitingReason } from './campaigns.schema';
import { flightDays } from './flight';
import { outstandingCreatives } from './moderation.service';

/**
 * What stands between a campaign and going live — the Campaigns lot (the
 * owner, 2 Oct 2026: "Campaigns section feels too weak").
 *
 * One derivation, read by the console's list (`waitingOn` on each row), the
 * launch queue (the rows and their facts) and the section overview (the
 * counts, through `launchQueueSummary`). Every reason is a gate the platform
 * already enforces or a step somebody still owes — nothing is invented:
 *
 *   RESERVATION_FEE  PENDING_PAYMENT with the RF-1 fee DUE — the advertiser owes the fee
 *   PAYMENT          PENDING_PAYMENT otherwise — the advertiser owes the checkout (the balance, when the fee is paid)
 *   DESIGN_QUOTE     PENDING_PAYMENT on the ADX Design Agency path with no quote yet (ADX owes one) or one QUOTED (the advertiser owes the answer)
 *   KYC              paid (SCHEDULED, or the fee PAID) and the advertiser not VERIFIED — QR-16's launch gate
 *   ARTWORK          artwork uploaded and not approved (`moderation.outstandingCreatives`) — Lot D's hard launch gate
 *   PUBLISHER        SCHEDULED with a booked spot whose order waits on its publisher to accept
 *   AGENT            SCHEDULED with a booked spot whose order no agent holds (none yet, or the one offered said no)
 *
 * A DRAFT waits on nobody but its author, and a campaign that is live,
 * paused, finished or cancelled waits on nothing: their list is empty.
 */

export { WAITING_REASONS };
export type { WaitingReason };

const PRE_LAUNCH = new Set(['PENDING_PAYMENT', 'SCHEDULED']);

/** Paid and not yet live: SCHEDULED, or held by a reservation fee that was paid. The launch queue's population. */
export function isPaidUnlaunched(facts: Pick<CampaignGateFacts, 'status' | 'reservationFeeStatus'>): boolean {
  return facts.status === 'SCHEDULED' || (facts.status === 'PENDING_PAYMENT' && facts.reservationFeeStatus === 'PAID');
}

type SpotFacts = CampaignGateFacts['spots'][number];
const liveSpot = (spot: SpotFacts) => spot.status !== 'CANCELLED';
const waitingOnPublisher = (spot: SpotFacts) =>
  liveSpot(spot) && !!spot.order && (PUBLISHER_WAITING_ORDER_STATUSES as readonly string[]).includes(spot.order.status);
const waitingOnAgent = (spot: SpotFacts) =>
  liveSpot(spot) && !!spot.order && (AGENT_WAITING_ORDER_STATUSES as readonly string[]).includes(spot.order.status);

/** The gates one campaign is waiting on, in `WAITING_REASONS` order; empty when nothing blocks. */
export function waitingOnOf(facts: CampaignGateFacts): WaitingReason[] {
  if (!PRE_LAUNCH.has(facts.status)) return [];
  const out = new Set<WaitingReason>();
  if (facts.status === 'PENDING_PAYMENT') {
    out.add(facts.reservationFeeStatus === 'DUE' ? 'RESERVATION_FEE' : 'PAYMENT');
    if (facts.creativePath === 'ADX_DESIGN_AGENCY' && (facts.designQuoteStatus === null || facts.designQuoteStatus === 'QUOTED')) out.add('DESIGN_QUOTE');
  }
  if (isPaidUnlaunched(facts) && facts.advertiser.kycStatus !== 'VERIFIED') out.add('KYC');
  if (outstandingCreatives(facts.creatives).length > 0) out.add('ARTWORK');
  if (facts.status === 'SCHEDULED') {
    if (facts.spots.some(waitingOnPublisher)) out.add('PUBLISHER');
    if (facts.spots.some(waitingOnAgent)) out.add('AGENT');
  }
  return WAITING_REASONS.filter((reason) => out.has(reason));
}

/**
 * Per reason, the fact a person needs to act on it — the launch queue's
 * one-click fixes and the campaign page's banner read these.
 */
export type WaitingFacts = {
  RESERVATION_FEE?: { amount: Money | null; dueAt: Date | null };
  /** `amountDue` is the total, less a paid reservation fee. */
  PAYMENT?: { amountDue: Money | null; sentForPaymentAt: Date | null; reservationFeePaid: boolean };
  DESIGN_QUOTE?: { state: 'NOT_QUOTED' | 'QUOTED'; amount: Money | null; quotedAt: Date | null };
  /** The advertiser profile the desk's "Request KYC" acts on, its KYC state, and whether the account is open to the request. */
  KYC?: { advertiserId: string; kycStatus: KycStatus; accountState: AccountState };
  /** The outstanding artwork, each with where it stands (IN_REVIEW is the desk's; AWAITING_ADVERTISER, REJECTED and CHANGES_REQUESTED the advertiser's). */
  ARTWORK?: { creatives: { id: string; status: CreativeStatus; designedByAdx: boolean }[] };
  PUBLISHER?: { spotIds: string[]; orderIds: string[] };
  AGENT?: { spotIds: string[]; orderIds: string[] };
};

const moneyOrNull = (value: Decimal | string | number | null | undefined): Money | null => (value === null || value === undefined ? null : money(value));

export function advertiserAccountState(advertiser: Pick<CampaignAdvertiserRow, 'user' | 'suspensionScopes'>): AccountState {
  return accountStateOf({ user: advertiser.user ? { isActive: advertiser.user.isActive, closedAt: advertiser.user.closedAt } : null, suspensionScopes: advertiser.suspensionScopes });
}

export function waitingFactsOf(facts: CampaignGateFacts, reasons: readonly WaitingReason[] = waitingOnOf(facts)): WaitingFacts {
  const out: WaitingFacts = {};
  for (const reason of reasons) {
    switch (reason) {
      case 'RESERVATION_FEE':
        out.RESERVATION_FEE = { amount: moneyOrNull(facts.reservationFeeAmount), dueAt: facts.reservationFeeDueAt };
        break;
      case 'PAYMENT': {
        const feePaid = facts.reservationFeeStatus === 'PAID' && facts.reservationFeeAmount !== null;
        const due = facts.total === null ? null : feePaid ? Decimal.max(new Decimal(facts.total).minus(facts.reservationFeeAmount!), 0) : new Decimal(facts.total);
        out.PAYMENT = { amountDue: moneyOrNull(due), sentForPaymentAt: facts.submittedForPaymentAt, reservationFeePaid: feePaid };
        break;
      }
      case 'DESIGN_QUOTE':
        out.DESIGN_QUOTE = {
          state: facts.designQuoteStatus === 'QUOTED' ? 'QUOTED' : 'NOT_QUOTED',
          amount: moneyOrNull(facts.designQuoteAmount),
          quotedAt: facts.designQuotedAt,
        };
        break;
      case 'KYC':
        out.KYC = { advertiserId: facts.advertiser.id, kycStatus: facts.advertiser.kycStatus, accountState: advertiserAccountState(facts.advertiser) };
        break;
      case 'ARTWORK':
        out.ARTWORK = { creatives: outstandingCreatives(facts.creatives).map((creative) => ({ id: creative.id, status: creative.status, designedByAdx: creative.designedByAdx })) };
        break;
      case 'PUBLISHER': {
        const spots = facts.spots.filter(waitingOnPublisher);
        out.PUBLISHER = { spotIds: spots.map((spot) => spot.id), orderIds: spots.map((spot) => spot.order!.id) };
        break;
      }
      case 'AGENT': {
        const spots = facts.spots.filter(waitingOnAgent);
        out.AGENT = { spotIds: spots.map((spot) => spot.id), orderIds: spots.map((spot) => spot.order!.id) };
        break;
      }
    }
  }
  return out;
}

/** Since when a queued campaign has waited: the payment, else the reservation fee's, else (not queued) the send-to-pay, else its creation. */
export function waitingSinceOf(facts: Pick<CampaignGateFacts, 'paidAt' | 'reservationFeePaidAt' | 'submittedForPaymentAt' | 'createdAt'>): Date {
  return facts.paidAt ?? facts.reservationFeePaidAt ?? facts.submittedForPaymentAt ?? facts.createdAt;
}

/** Whole days since, never negative. */
export const wholeDaysSince = (since: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000));

/* ── The row's other derived columns ──────────────────────────────────── */

/**
 * PB-1's shape for a campaign: the orders' `placedBy`. `userId` is the
 * advertiser's login (null for an account the desk holds for somebody who
 * has not registered); `name` the person — first and last name, else the
 * display name; `displayId` the person's ADX-… id; `business` the
 * advertiser profile itself (never null on a campaign, typed as on orders).
 */
export type CampaignAdvertiser = {
  userId: string | null;
  name: string | null;
  displayId: string | null;
  business: { id: string; name: string; displayId: string | null } | null;
};

export function campaignAdvertiserOf(advertiser: Pick<CampaignAdvertiserRow, 'id' | 'name' | 'displayId' | 'userId' | 'user'>): CampaignAdvertiser {
  const user = advertiser.user;
  const parts = [user?.firstName, user?.lastName].map((part) => part?.trim()).filter((part): part is string => !!part);
  return {
    userId: user?.id ?? advertiser.userId ?? null,
    name: parts.length ? parts.join(' ') : user?.name?.trim() || null,
    displayId: user?.displayId ?? null,
    business: { id: advertiser.id, name: advertiser.name, displayId: advertiser.displayId },
  };
}

/**
 * What the advertiser has actually paid: the total once the campaign is
 * paid (`paidAt` — the wallet hold or the gateway, captured at launch), the
 * reservation fee while only that is paid, null when nothing is.
 */
export function paidAmountOf(facts: Pick<CampaignGateFacts, 'paidAt' | 'total' | 'reservationFeeStatus' | 'reservationFeeAmount'>): Money | null {
  if (facts.paidAt && facts.total !== null) return money(facts.total);
  if (facts.reservationFeeStatus === 'PAID' && facts.reservationFeeAmount !== null) return money(facts.reservationFeeAmount);
  return null;
}

/** A LIVE campaign's days left, today included (UTC days, the way the flight is stored); null when it is not live or has no end. */
export function daysLeftOf(facts: Pick<CampaignGateFacts, 'status' | 'endDate'>, now: Date): number | null {
  if (facts.status !== 'LIVE' || !facts.endDate) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = Date.UTC(facts.endDate.getUTCFullYear(), facts.endDate.getUTCMonth(), facts.endDate.getUTCDate());
  return end < today ? 0 : flightDays(now, facts.endDate);
}

/** Spots booked and not cancelled, and those of them live. */
export function spotCountsOf(spots: readonly { status: string }[]): { spotsLive: number; spotsTotal: number } {
  const standing = spots.filter((spot) => spot.status !== 'CANCELLED');
  return { spotsLive: standing.filter((spot) => spot.status === 'LIVE').length, spotsTotal: standing.length };
}

export const NO_PERFORMANCE: CampaignPerformanceTotals = Object.freeze({ scans: 0, views: 0, ctaClicks: 0, enquiries: 0 });
