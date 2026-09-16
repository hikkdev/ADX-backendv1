import { ApiError } from '../../../shared/errors';
import { Decimal, money, type Money } from '../../../shared/money';
import { countAcceptancesFor } from '../../agreements';
import { listOpenCampaignsForAdvertiser } from '../../campaigns';
import { getListingsForPublisher } from '../../listings';
import { countDispatchedMilestones } from '../../order-milestones';
import {
  countPendingAgentOffers,
  findOpenOrdersForAdvertiserUser,
  findOpenOrdersForListings,
} from '../../orders';
import { listWithdrawals } from '../../payouts';
import { countOpenTicketsForUser } from '../../support';
import { countOpenVisitsForAgent } from '../../visits';
import { findWalletFor, snapshot } from '../../wallets';
import { prismaAccountLifecycleRepository as repository } from '../prisma-account-lifecycle.repository';
import type { PartyIds } from '../account-lifecycle.repository';

/**
 * What is standing between this account and closure -- Lot A (Q21).
 *
 * The owner's rule: an account is closed when nothing of ADX's is left inside
 * it. Three things make that untrue and stop a closure dead:
 *
 *   money leaving      a withdrawal already vetted or on the rail. Closing
 *                      over it would freeze the wallet under a payment that
 *                      finance has already promised.
 *   work running       a non-terminal order, on either side of it. Cancelling
 *                      is a decision with a refund attached; it is not
 *                      something a close button does silently.
 *   inventory bought   a SCHEDULED or LIVE campaign. Same reason, from the
 *                      demand side.
 *
 * Everything else is reported and never blocks. Open agent offers are the
 * clearest case: the closure hands them back through the suspension's
 * STOP_OPEN_WORK, so refusing on them would be refusing on something the very
 * next step undoes. Agreements and support tickets are history and
 * correspondence -- neither is ADX's money.
 */

export const BLOCKER_KINDS = [
  'WITHDRAWALS_IN_FLIGHT',
  'OPEN_ORDERS',
  'OPEN_CAMPAIGNS',
  'OPEN_AGENT_WORK',
  'WALLET_BALANCE',
  'OPEN_AGREEMENTS',
  'OPEN_TICKETS',
] as const;

export type BlockerKind = (typeof BLOCKER_KINDS)[number];

export type Blocker = {
  kind: BlockerKind;
  label: string;
  count: number;
  /** True when a closure is refused while this stands. */
  blocking: boolean;
  /** What the console draws under the line -- ids, references, an amount. */
  detail?: unknown;
};

export type WalletLine = {
  kind: 'PUBLISHER' | 'ADVERTISER' | 'AGENT';
  partyId: string;
  walletId: string;
  balance: Money;
  withdrawable: Money;
  frozenAt: Date | null;
};

export type ClosureReview = {
  userId: string;
  name: string | null;
  mobile: string;
  closedAt: Date | null;
  parties: { publisherId: string | null; advertiserId: string | null; agentProfileId: string | null };
  wallets: WalletLine[];
  summary: {
    /** Every wallet the account's profiles own, added up. */
    walletBalance: Money;
    withdrawalsInFlight: number;
    openOrders: number;
    openWork: number;
    openCampaigns: number;
    openAgreements: number;
    openTickets: number;
    canClose: boolean;
  };
  blockers: Blocker[];
  /** The ids the closure itself needs, carried so it does not ask twice. */
  context: {
    wallets: WalletLine[];
    listingIds: string[];
    openOrderIds: string[];
  };
};

/** The withdrawal states in which ADX has already committed to paying. */
const IN_FLIGHT = ['REQUESTED', 'APPROVED', 'PROCESSING'] as const;

export async function requireParties(userId: string): Promise<PartyIds> {
  const parties = await repository.findParties(userId);
  if (!parties) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return parties;
}

async function walletLines(parties: PartyIds): Promise<WalletLine[]> {
  const owners = [
    ...(parties.publisherId ? [{ kind: 'PUBLISHER' as const, id: parties.publisherId }] : []),
    ...(parties.advertiserId ? [{ kind: 'ADVERTISER' as const, id: parties.advertiserId }] : []),
    ...(parties.agentProfileId ? [{ kind: 'AGENT' as const, id: parties.agentProfileId }] : []),
  ];

  const lines: WalletLine[] = [];
  for (const owner of owners) {
    const wallet = await findWalletFor(owner);
    if (!wallet) continue;
    const balances = await snapshot(wallet.id);
    lines.push({
      kind: owner.kind,
      partyId: owner.id,
      walletId: wallet.id,
      balance: balances.balance,
      withdrawable: balances.withdrawable,
      frozenAt: balances.frozenAt,
    });
  }
  return lines;
}

/**
 * The investigation, run whole.
 *
 * Deliberately one read across every module rather than a count cached on the
 * case: the case records what was true when it was raised, and the decision
 * re-runs this so nothing is closed on a week-old number.
 */
export async function closureReview(userId: string): Promise<ClosureReview> {
  const parties = await requireParties(userId);
  const wallets = await walletLines(parties);

  const inFlight = (
    await Promise.all(
      wallets.map((line) =>
        listWithdrawals({ walletId: line.walletId, status: [...IN_FLIGHT], limit: 200 }),
      ),
    )
  ).flat();

  const listings = parties.publisherId ? await getListingsForPublisher(parties.publisherId) : [];
  const listingIds = listings.map((listing) => listing.id);

  const [onListings, asAdvertiser] = await Promise.all([
    findOpenOrdersForListings(listingIds),
    findOpenOrdersForAdvertiserUser(userId),
  ]);
  // An account can be both sides of the same order in theory; count it once.
  const openOrderIds = [...new Set([...onListings, ...asAdvertiser].map((order) => order.id))];

  const campaigns = parties.advertiserId
    ? await listOpenCampaignsForAdvertiser(parties.advertiserId)
    : [];

  const agentWork = parties.agentProfileId
    ? await Promise.all([
        countPendingAgentOffers(parties.agentProfileId),
        countOpenVisitsForAgent(parties.agentProfileId),
        countDispatchedMilestones(parties.agentProfileId),
      ])
    : [0, 0, 0];
  const [offers, visits, milestones] = agentWork;
  const openWork = (offers ?? 0) + (visits ?? 0) + (milestones ?? 0);

  const [agreements, tickets] = await Promise.all([
    countAcceptancesFor({
      publisherId: parties.publisherId ?? undefined,
      advertiserId: parties.advertiserId ?? undefined,
    }),
    countOpenTicketsForUser(userId),
  ]);

  const balance = wallets.reduce((total, line) => total.plus(new Decimal(line.balance)), new Decimal(0));

  const blockers: Blocker[] = [];
  const add = (blocker: Blocker): void => {
    if (blocker.count > 0) blockers.push(blocker);
  };

  add({
    kind: 'WITHDRAWALS_IN_FLIGHT',
    label: 'Withdrawals ADX has already promised',
    count: inFlight.length,
    blocking: true,
    detail: inFlight.map((row) => ({ id: row.id, reference: row.reference, status: row.status })),
  });
  add({
    kind: 'OPEN_ORDERS',
    label: 'Orders still running',
    count: openOrderIds.length,
    blocking: true,
    detail: openOrderIds,
  });
  add({
    kind: 'OPEN_CAMPAIGNS',
    label: 'Campaigns scheduled or live',
    count: campaigns.length,
    blocking: true,
    detail: campaigns,
  });
  add({
    kind: 'OPEN_AGENT_WORK',
    label: 'Agent work in hand',
    count: openWork,
    blocking: false,
    detail: { offers: offers ?? 0, visits: visits ?? 0, milestones: milestones ?? 0 },
  });
  add({
    kind: 'WALLET_BALANCE',
    label: 'Money still in the wallet',
    count: wallets.filter((line) => new Decimal(line.balance).greaterThan(0)).length,
    blocking: false,
    detail: { balance: money(balance), wallets },
  });
  add({
    kind: 'OPEN_AGREEMENTS',
    label: 'Agreements signed',
    count: agreements,
    blocking: false,
  });
  add({
    kind: 'OPEN_TICKETS',
    label: 'Support tickets open',
    count: tickets,
    blocking: false,
  });

  return {
    userId,
    name: parties.name,
    mobile: parties.mobile,
    closedAt: parties.closedAt,
    parties: {
      publisherId: parties.publisherId,
      advertiserId: parties.advertiserId,
      agentProfileId: parties.agentProfileId,
    },
    wallets,
    summary: {
      walletBalance: money(balance),
      withdrawalsInFlight: inFlight.length,
      openOrders: openOrderIds.length,
      openWork,
      openCampaigns: campaigns.length,
      openAgreements: agreements,
      openTickets: tickets,
      canClose: blockers.every((blocker) => !blocker.blocking),
    },
    blockers,
    context: { wallets, listingIds, openOrderIds },
  };
}

/** The blockers that actually refuse a closure. */
export const blockingOf = (review: ClosureReview): Blocker[] =>
  review.blockers.filter((blocker) => blocker.blocking);
