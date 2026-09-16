import { Decimal, money, type Money } from '../../../shared/money';
import { monthWindowIST } from '../../../shared/time';
import { earningsSummary, listAccrualsForPeriod, listWithdrawals, paidWithdrawalTotal } from '../../payouts';
import { findWalletFor, snapshot } from '../../wallets';
import { getOwnedPublisher } from '../publishers.service';
import { prismaPublisherSummaryRepository as repository, type SummaryListing } from './prisma-publisher-summary.repository';
import { publisherSummaryPort } from './summary.port';

/**
 * P-B: `GET /publishers/:id/summary` — the publisher's detail card, the
 * mirror of the advertiser's (`advertisers/book`): the row, the metrics, the
 * spots and an activity feed.
 *
 * Every figure is read from where it is owned. The accruals and the payouts
 * come through `payouts`, the wallet through `wallets`; the subscription
 * (`revenue`) and the visits (`visits`) through the port bootstrap fills,
 * because both of those modules already reach this one. This module's own
 * repository reads only what this module can vouch for — the spots, the
 * bookings on them, the action log. Money is a decimal string everywhere,
 * because a running total serialised through a JSON number hands float
 * error back to the console.
 */

/** Same cap as the advertiser card. */
export const FEED_LIMIT = 30;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The Indian calendar month `now` falls in, as two windows: the accrual
 * one on `forDate` — a UTC-midnight date column, so `[1st 00:00Z, next 1st
 * 00:00Z)`, the way `invoices` dates a payment advice — and the instant one
 * on `paidAt` / `createdAt`, closing at the next month's IST midnight.
 */
export function publisherMonthWindows(now: Date): { accruals: { start: Date; end: Date }; instants: { start: Date; end: Date } } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  return {
    accruals: { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) },
    instants: monthWindowIST(year, month),
  };
}

export type SummaryListingView = {
  id: string;
  displayId: string | null;
  title: string;
  category: string;
  city: string | null;
  status: string;
  /** ACTIVE — bookable, on the marketplace. */
  live: boolean;
  occupied: boolean;
  publishedAt: string | null;
  ratePerDay: Money | null;
  ratingAvg: string | null;
  reviewCount: number;
};

export type PublisherSummaryMetrics = {
  earningsThisMonth: Money;
  earningsLifetime: Money;
  payoutsReleased: { lifetime: Money; thisMonth: Money };
  walletBalance: Money;
  withdrawable: Money;
  listingsTotal: number;
  listingsLive: number;
  bookingsThisMonth: number;
  bookingsLifetime: number;
  /** Across the spots' review snapshots, weighted by their review counts; null with no review at all. */
  ratingAvg: string | null;
  subscription: { tier: string; endsAt: string | null } | null;
};

export type FeedEventView = {
  kind: 'ACTIVITY' | 'FIELD_VISIT' | 'LISTING_LIVE' | 'BOOKING_AUTHORISED' | 'PAYOUT_RELEASED';
  at: string;
  title: string;
  detail: string | null;
};

export type PublisherSummary = {
  publisher: Awaited<ReturnType<typeof getOwnedPublisher>>;
  metrics: PublisherSummaryMetrics;
  listings: SummaryListingView[];
  activity: FeedEventView[];
};

const toListingView = (listing: SummaryListing): SummaryListingView => ({
  id: listing.id,
  displayId: listing.displayId,
  title: listing.title,
  category: listing.category,
  city: listing.city,
  status: listing.status,
  live: listing.status === 'ACTIVE',
  occupied: listing.occupied,
  publishedAt: listing.publishedAt?.toISOString() ?? null,
  ratePerDay: listing.ratePerDay === null ? null : money(listing.ratePerDay),
  ratingAvg: listing.ratingAvg === null ? null : money(listing.ratingAvg),
  reviewCount: listing.reviewCount,
});

/**
 * The publisher's rating, from the snapshots `reviews` keeps on each spot —
 * a publisher has no rating of their own, and `reviews` exports none, so the
 * card averages the spots weighted by the reviews behind each. Null while
 * nobody has reviewed anything of theirs.
 */
export function ratingAcross(listings: readonly { ratingAvg: Decimal | null; reviewCount: number }[]): string | null {
  let weighted = new Decimal(0);
  let reviews = 0;
  for (const listing of listings) {
    if (listing.ratingAvg === null || listing.reviewCount <= 0) continue;
    weighted = weighted.plus(new Decimal(listing.ratingAvg).times(listing.reviewCount));
    reviews += listing.reviewCount;
  }
  return reviews === 0 ? null : weighted.div(reviews).toFixed(2);
}

const visitTitle = (kind: string) => (kind === 'ONBOARDING' ? 'Onboarding visit' : kind === 'RENEWAL' ? 'Renewal visit' : kind === 'FOLLOW_UP' ? 'Follow-up visit' : kind === 'AUDIT' ? 'Audit visit' : 'Visit');

export async function publisherSummary(publisherId: string, viewerUserId: string, now = new Date()): Promise<PublisherSummary> {
  // The row as the party page reads it — 404 when the id names nobody; the
  // route is ADMIN's, so the agent-ownership rule is skipped as it is there.
  const publisher = await getOwnedPublisher(publisherId, viewerUserId, { isAdmin: true });
  const { accruals: accrualMonth, instants: month } = publisherMonthWindows(now);

  const [listings, bookings, lifetime, monthAccruals, paidLifetime, paidThisMonth, wallet, subscription, ownFeed, visits, payouts] = await Promise.all([
    repository.listingsOf(publisherId, now),
    repository.bookingFacts(publisherId, month),
    earningsSummary(publisherId, now),
    listAccrualsForPeriod(publisherId, accrualMonth.start, accrualMonth.end),
    paidWithdrawalTotal({ publisherId }),
    paidWithdrawalTotal({ publisherId, paidFrom: month.start, paidTo: month.end }),
    findWalletFor({ kind: 'PUBLISHER', id: publisherId }),
    publisherSummaryPort().runningSubscription(publisherId, now),
    repository.feedOf(publisherId, FEED_LIMIT),
    publisherSummaryPort().visits(publisherId, FEED_LIMIT),
    listWithdrawals({ publisherId, status: ['PAID'], limit: FEED_LIMIT }),
  ]);
  // A publisher who has never earned has no wallet yet: zero, not a 404.
  const balances = wallet ? await snapshot(wallet.id, now) : null;

  const metrics: PublisherSummaryMetrics = {
    earningsThisMonth: money(monthAccruals.reduce((sum, row) => sum.plus(row.net), new Decimal(0))),
    earningsLifetime: money(lifetime.netEarned),
    payoutsReleased: { lifetime: money(paidLifetime.total), thisMonth: money(paidThisMonth.total) },
    walletBalance: money(balances?.balance ?? 0),
    withdrawable: money(balances?.withdrawable ?? 0),
    listingsTotal: listings.length,
    listingsLive: listings.filter((listing) => listing.status === 'ACTIVE').length,
    bookingsThisMonth: bookings.thisMonth,
    bookingsLifetime: bookings.lifetime,
    ratingAvg: ratingAcross(listings),
    subscription: subscription ? { tier: subscription.tier, endsAt: subscription.endsAt?.toISOString() ?? null } : null,
  };

  const events: { kind: FeedEventView['kind']; at: Date; title: string; detail: string | null }[] = [
    ...ownFeed,
    ...visits.map((visit) => ({
      kind: 'FIELD_VISIT' as const,
      at: new Date(visit.completedAt ?? visit.scheduledFor ?? now),
      title: `${visitTitle(visit.kind)} at ${visit.businessName}${visit.locality ? ` ${visit.locality}` : ''}`,
      detail: visit.status === 'COMPLETED' ? null : visit.status === 'IN_PROGRESS' ? 'In progress' : 'Scheduled',
    })),
    ...payouts.flatMap((line) =>
      line.paidAt ? [{ kind: 'PAYOUT_RELEASED' as const, at: line.paidAt, title: `Payout released: ${money(line.netAmount)}`, detail: line.reference }] : [],
    ),
  ];
  const activity = events
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, FEED_LIMIT)
    .map((event) => ({ kind: event.kind, at: event.at.toISOString(), title: event.title, detail: event.detail }));

  return { publisher, metrics, listings: listings.map(toListingView), activity };
}
