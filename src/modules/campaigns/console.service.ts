import type { Request } from 'express';
import { ApiError } from '../../shared/errors';
import { findActivityRows, logActivity } from '../../shared/audit';
import { logger } from '../../shared/logging';
import { money, type Money } from '../../shared/money';
import type { ListPage } from '../../shared/pagination';
import { createNotification } from '../notifications';
import { cityKeyFor } from '../pricing';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import type { LandingPageStatus } from '../../shared/database';
import type { CampaignAggregate, CampaignGateFacts, CampaignListRow, CampaignPerformanceTotals, LandingPageView } from './campaigns.repository';
import { WAITING_REASONS, type LandingPageListQuery, type LaunchQueueQuery, type WaitingReason } from './campaigns.schema';
import {
  NO_PERFORMANCE,
  advertiserAccountState,
  campaignAdvertiserOf,
  daysLeftOf,
  isPaidUnlaunched,
  paidAmountOf,
  spotCountsOf,
  waitingFactsOf,
  waitingOnOf,
  waitingSinceOf,
  wholeDaysSince,
  type CampaignAdvertiser,
  type WaitingFacts,
} from './launch-gates';
import { landingPageUrl } from './landing-url';

/**
 * The console's reads of campaigns — the Campaigns lot (the owner, 2 Oct
 * 2026: "Campaigns section feels too weak here" / "Landing pages … we don't
 * even know how they work").
 *
 * ADMIN only, every one: the list's extra columns, the launch queue, the
 * reminder to pay, the detail's waiting banner, the landing-page list's
 * advertiser and numbers. Each carries the advertiser as the orders'
 * `placedBy` — a party's own reads never do.
 */

/** How many candidates one read folds at most — the launch queue and a `waitingOn` filter read the population, then page it. */
export const GATE_CANDIDATE_CAP = 5_000;

/* ── City ─────────────────────────────────────────────────────────────── */

/** Lot X-B: a city facet (slug or name) and the key it resolves to — null when it resolves to none. */
export async function campaignCityScope(city: string | undefined): Promise<{ city?: string; cityId?: string | null }> {
  const typed = city?.trim();
  if (!typed) return {};
  return { city: typed, cityId: (await cityKeyFor(typed))?.cityId ?? null };
}

/* ── The list's console columns ───────────────────────────────────────── */

export type ConsoleColumns = {
  advertiser: CampaignAdvertiser | null;
  /** The same narrow summary `GET /campaigns/:id` carries — `{ id, slug, status, url, publishedAt }` — or null with no page. */
  landingPage: { id: string; slug: string; status: LandingPageStatus; url: string; publishedAt: Date | null } | null;
  waitingOn: WaitingReason[];
  spotsLive: number;
  spotsTotal: number;
  performance: CampaignPerformanceTotals;
  paidAmount: Money | null;
  daysLeft: number | null;
};
export type ConsoleCampaignRow = Omit<CampaignListRow, 'advertiser'> & ConsoleColumns;

/**
 * `GET /campaigns` for ADX: the row the apps read, with the advertiser as
 * `placedBy`, its landing page (the detail's narrow summary), what it waits
 * on, its spots, its lifetime engagement, what was paid and the days left.
 * Two reads for the whole page — the gate facts and
 * the engagement — never one per row.
 */
export async function withConsoleColumns(rows: CampaignListRow[], now = new Date()): Promise<ConsoleCampaignRow[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [facts, performance] = await Promise.all([repository.campaignGateFacts(ids), repository.performanceTotals(ids)]);
  const byId = new Map(facts.map((row) => [row.id, row]));
  return rows.map(({ advertiser: _apps, ...row }) => {
    const gate = byId.get(row.id);
    const counts = gate ? spotCountsOf(gate.spots) : { spotsLive: 0, spotsTotal: row.spotCount };
    return {
      ...row,
      advertiser: gate ? campaignAdvertiserOf(gate.advertiser) : null,
      landingPage: gate?.landingPage ? { ...gate.landingPage, url: landingPageUrl(gate.landingPage.slug) } : null,
      waitingOn: gate ? waitingOnOf(gate) : [],
      ...counts,
      performance: performance[row.id] ?? { ...NO_PERFORMANCE },
      paidAmount: gate ? paidAmountOf(gate) : null,
      daysLeft: gate ? daysLeftOf(gate, now) : null,
    };
  });
}

/**
 * A `waitingOn` filter, resolved to the ids it keeps: the candidates the
 * prefilter reads (a superset), narrowed by the one derivation the rows
 * carry — so a row the filter keeps always says why.
 */
export async function idsWaitingOn(
  scope: Parameters<typeof repository.gateCandidates>[0],
): Promise<string[]> {
  const wanted = new Set(scope.reasons);
  const candidates = await repository.gateCandidates(scope, GATE_CANDIDATE_CAP);
  if (candidates.length >= GATE_CANDIDATE_CAP) logger.warn('A waitingOn filter reached its candidate cap', { cap: GATE_CANDIDATE_CAP, reasons: scope.reasons });
  return candidates.filter((facts) => waitingOnOf(facts).some((reason) => wanted.has(reason))).map((facts) => facts.id);
}

/* ── The launch queue ─────────────────────────────────────────────────── */

export type LaunchQueueRow = {
  id: string;
  reference: string;
  name: string;
  status: CampaignGateFacts['status'];
  brandName: string | null;
  startDate: Date | null;
  endDate: Date | null;
  total: Money | null;
  paidAmount: Money | null;
  paidAt: Date | null;
  reservationFeePaidAt: Date | null;
  advertiser: CampaignAdvertiser;
  waitingOn: WaitingReason[];
  waitingFacts: WaitingFacts;
  /** When the payment (or the reservation fee) landed — the queue is worked oldest first. */
  waitingSince: Date;
  waitingDays: number;
};

/** `counts`: one per reason (a campaign waiting on two counts under both), and `ALL` — every campaign in the queue. */
export type LaunchQueuePage = ListPage<LaunchQueueRow>;

type Queued = { facts: CampaignGateFacts; waitingOn: WaitingReason[] };

async function queued(scope: { q?: string | undefined; city?: string | undefined; cityId?: string | null | undefined }): Promise<Queued[]> {
  const candidates = await repository.gateCandidates({ ...scope, reasons: [], paidOnly: true }, GATE_CANDIDATE_CAP);
  if (candidates.length >= GATE_CANDIDATE_CAP) logger.warn('The launch queue reached its candidate cap', { cap: GATE_CANDIDATE_CAP });
  return candidates
    .filter(isPaidUnlaunched)
    .map((facts) => ({ facts, waitingOn: waitingOnOf(facts) }))
    .filter((row) => row.waitingOn.length > 0);
}

const countsOf = (rows: readonly Queued[]): Record<string, number> => {
  const counts: Record<string, number> = { ALL: rows.length };
  for (const reason of WAITING_REASONS) counts[reason] = rows.filter((row) => row.waitingOn.includes(reason)).length;
  return counts;
};

/**
 * `GET /campaigns/launch-queue` — paid (or reservation-fee-paid) campaigns
 * that cannot go live yet, each with what it waits on and the fact needed
 * to act, oldest-waiting first. `reason` narrows to any of those gates; the
 * counts are taken without it.
 */
export async function launchQueue(query: LaunchQueueQuery, now = new Date()): Promise<LaunchQueuePage> {
  const rows = await queued({ ...(query.q ? { q: query.q } : {}), ...(await campaignCityScope(query.city)) });
  const counts = countsOf(rows);
  const wanted = query.reason?.length ? new Set<WaitingReason>(query.reason) : null;
  const kept = (wanted ? rows.filter((row) => row.waitingOn.some((reason) => wanted.has(reason))) : rows)
    .map((row) => ({ ...row, since: waitingSinceOf(row.facts) }))
    .sort((a, b) => a.since.getTime() - b.since.getTime() || a.facts.reference.localeCompare(b.facts.reference));
  const page = kept.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  return {
    items: page.map(({ facts, waitingOn, since }) => ({
      id: facts.id,
      reference: facts.reference,
      name: facts.name,
      status: facts.status,
      brandName: facts.brandName,
      startDate: facts.startDate,
      endDate: facts.endDate,
      total: facts.total === null ? null : money(facts.total),
      paidAmount: paidAmountOf(facts),
      paidAt: facts.paidAt,
      reservationFeePaidAt: facts.reservationFeePaidAt,
      advertiser: campaignAdvertiserOf(facts.advertiser),
      waitingOn,
      waitingFacts: waitingFactsOf(facts, waitingOn),
      waitingSince: since,
      waitingDays: wholeDaysSince(since, now),
    })),
    total: kept.length,
    page: query.page,
    pageSize: query.pageSize,
    counts,
  };
}

/**
 * The launch queue counted — what the Campaigns overview's "waiting to
 * launch" tile and its work list read (through the module's index). The
 * same population and derivation as the queue itself.
 */
export async function launchQueueSummary(scope: { city?: string | undefined; cityId?: string | null | undefined } = {}): Promise<{ total: number; byReason: Record<WaitingReason, number> }> {
  const counts = countsOf(await queued(scope));
  const byReason = Object.fromEntries(WAITING_REASONS.map((reason) => [reason, counts[reason] ?? 0])) as Record<WaitingReason, number>;
  return { total: counts['ALL'] ?? 0, byReason };
}

/* ── The campaign page ────────────────────────────────────────────────── */

export type ConsoleDetailExtras = {
  placedBy: CampaignAdvertiser | null;
  waitingOn: WaitingReason[];
  waitingFacts: WaitingFacts;
  paidAmount: Money | null;
  daysLeft: number | null;
};

/**
 * `GET /campaigns/:id` for ADX: the header's "Placed by" line and the
 * waiting banner's reasons and facts. `placedBy`, because the detail's own
 * `advertiser` is the narrow `{ id, name, companyName }` the apps read.
 */
export async function consoleDetailExtras(campaignId: string, now = new Date()): Promise<ConsoleDetailExtras> {
  const [facts] = await repository.campaignGateFacts([campaignId]);
  if (!facts) return { placedBy: null, waitingOn: [], waitingFacts: {}, paidAmount: null, daysLeft: null };
  const waitingOn = waitingOnOf(facts);
  return {
    placedBy: campaignAdvertiserOf(facts.advertiser),
    waitingOn,
    waitingFacts: waitingFactsOf(facts, waitingOn),
    paidAmount: paidAmountOf(facts),
    daysLeft: daysLeftOf(facts, now),
  };
}

/* ── The reminder to pay ──────────────────────────────────────────────── */

export const PAYMENT_REMINDER_ACTION = 'CAMPAIGN_PAYMENT_REMINDED';
export const PAYMENT_REMINDER_INTERVAL_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

export type PaymentReminder = {
  campaignId: string;
  reference: string;
  /** What the advertiser was reminded to pay. */
  about: 'PAYMENT' | 'RESERVATION_FEE';
  amountDue: Money | null;
  remindedAt: Date;
  nextAllowedAt: Date;
};

/**
 * `POST /campaigns/:id/remind-payment` — ADX nudges the advertiser of a
 * campaign awaiting payment (or its reservation fee) through the in-app
 * notification every campaign message uses. Once per 24 hours per
 * campaign: the audit trail is the clock (the last `CAMPAIGN_PAYMENT_REMINDED`
 * against the campaign), so the limit survives a restart and a second
 * console. Refused for anything not awaiting payment (409), an advertiser
 * with no login to tell or an account that is not working (409), and a
 * second reminder inside the day (429, with when the next may go).
 */
export async function remindPayment(campaign: CampaignAggregate, byUserId: string, now = new Date(), req?: Request): Promise<PaymentReminder> {
  if (campaign.status !== 'PENDING_PAYMENT') {
    throw new ApiError(409, 'CONFLICT', 'Only a campaign awaiting payment can be reminded.');
  }
  const [facts] = await repository.campaignGateFacts([campaign.id]);
  const advertiser = facts?.advertiser;
  if (!advertiser?.userId) {
    throw new ApiError(409, 'CONFLICT', 'This advertiser has no login yet, so there is nobody to remind.');
  }
  const state = advertiserAccountState(advertiser);
  if (state !== 'ACTIVE') {
    throw new ApiError(409, 'CONFLICT', `This advertiser's account is ${state.toLowerCase()}, so no reminder goes out.`, { accountState: state });
  }

  const since = new Date(now.getTime() - PAYMENT_REMINDER_INTERVAL_HOURS * HOUR_MS);
  const [last] = await findActivityRows(
    { action: PAYMENT_REMINDER_ACTION, targetType: 'Campaign', targetId: campaign.id, from: since },
    { skip: 0, take: 1, sort: 'newest' },
  );
  if (last) {
    const nextAllowedAt = new Date(last.createdAt.getTime() + PAYMENT_REMINDER_INTERVAL_HOURS * HOUR_MS);
    throw new ApiError(429, 'TOO_MANY_REQUESTS', `The advertiser was reminded within the last ${PAYMENT_REMINDER_INTERVAL_HOURS} hours. The next reminder can go after ${nextAllowedAt.toISOString()}.`, {
      lastRemindedAt: last.createdAt,
      nextAllowedAt,
    });
  }

  const about = facts!.reservationFeeStatus === 'DUE' ? 'RESERVATION_FEE' : 'PAYMENT';
  const waiting = waitingFactsOf(facts!, [about]);
  const amountDue = about === 'RESERVATION_FEE' ? (waiting.RESERVATION_FEE?.amount ?? null) : (waiting.PAYMENT?.amountDue ?? null);
  const amount = amountDue ? ` INR ${amountDue}` : '';
  await createNotification({
    userId: advertiser.userId,
    type: 'BOOKING',
    title: about === 'RESERVATION_FEE' ? 'Your reservation fee is due' : 'Your campaign is waiting for payment',
    subtitle: campaign.name,
    message:
      about === 'RESERVATION_FEE'
        ? `${campaign.reference} is reserved for you. Pay the reservation fee of${amount || ' the amount shown'} to keep the spots held.`
        : `${campaign.reference} is ready and waiting for you to pay${amount ? `${amount}` : ''}. Pay to book the spots before someone else does.`,
    suggestedAction: about === 'RESERVATION_FEE' ? 'Pay the fee' : 'Review and pay',
    relatedId: campaign.id,
    relatedType: 'CAMPAIGN',
  });
  await logActivity(byUserId, PAYMENT_REMINDER_ACTION, {
    ...(req ? { req } : {}),
    module: 'campaigns',
    targetType: 'Campaign',
    targetId: campaign.id,
    metadata: { reference: campaign.reference, advertiserId: advertiser.id, about, amountDue },
  });
  return {
    campaignId: campaign.id,
    reference: campaign.reference,
    about,
    amountDue,
    remindedAt: now,
    nextAllowedAt: new Date(now.getTime() + PAYMENT_REMINDER_INTERVAL_HOURS * HOUR_MS),
  };
}

/* ── The landing-page list ────────────────────────────────────────────── */

export type ConsoleLandingPageRow = Omit<LandingPageView, never> & {
  url: string;
  /** The hero block's headline — the page's title as the public page prints it; null when it has no hero. */
  heroTitle: string | null;
  advertiser: CampaignAdvertiser | null;
  views: number;
  ctaClicks: number;
  enquiries: number;
};

/** The hero block's headline, read defensively — the blocks are JSON. */
export function heroTitleOf(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const hero = blocks.find((block) => !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'hero') as { headline?: unknown } | undefined;
  return typeof hero?.headline === 'string' && hero.headline.trim() ? hero.headline.trim() : null;
}

/**
 * `GET /campaigns/landing-pages` — the review list (Lot E) with what the
 * console's table draws beside each page: its public address, its title,
 * the advertiser as `placedBy`, and the page's own numbers (views, CTA
 * presses, form submissions — the engagement read the campaigns list uses,
 * one pair of queries per page).
 */
export async function listLandingPagesForConsole(query: LandingPageListQuery): Promise<{ items: ConsoleLandingPageRow[]; total: number; counts: Record<string, number> }> {
  const { items, total, counts } = await repository.listLandingPages(query);
  const performance = await repository.performanceTotals([...new Set(items.map((row) => row.campaignId))]);
  return {
    items: items.map(({ advertiserRow, ...row }) => {
      const numbers = performance[row.campaignId] ?? NO_PERFORMANCE;
      return {
        ...row,
        url: landingPageUrl(row.slug),
        heroTitle: heroTitleOf(row.blocks),
        advertiser: advertiserRow ? campaignAdvertiserOf(advertiserRow) : null,
        views: numbers.views,
        ctaClicks: numbers.ctaClicks,
        enquiries: numbers.enquiries,
      };
    }),
    total,
    counts,
  };
}
