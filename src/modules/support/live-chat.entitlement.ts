import { findAdvertiserLabelsForUsers, getAdvertiserForUser } from '../advertisers';
import { getPlatformSettings, type LiveChatSettings } from '../app-config';
import { entitledPackageForAdvertiser, entitledPackagesForAdvertisers } from '../packages';
import { findPublisherForUser, findPublisherLabelsForUsers } from '../publishers';
import { entitledSubscriptionForPublisher, entitledSubscriptionsForPublishers, publisherPlansByTier } from '../revenue';

/**
 * Who gets live chat — Lot I, the owner's decision of 14 Sep 2026: it is a
 * feature for **paid subscribers**.
 *
 * Two ways to be one, and one way to be told no:
 *
 *  - **A publisher on a running subscription** (`PublisherSubscription` in
 *    force now, read through `revenue`, which owns the table) **whose tier's
 *    plan** (`revenue.publisherPlansByTier`, Lot J-B1) does not set
 *    `entitlements.liveChat: false` — the console's plan editor is where a
 *    tier is switched, the same way the advertiser catalogue is — and, on
 *    top, `support.liveChat.publisherTiers` may narrow it: an empty list, the
 *    default, means every tier the plan allows.
 *  - **An advertiser on an ACTIVE package sale** whose plan's `entitlements`
 *    JSON does not set `liveChat: false`. The catalogue editor
 *    (`PATCH /catalogue/plans/:tier`) is where that is switched per plan, so
 *    excluding the starter tier is an ops edit rather than a deploy.
 *  - Everybody else — an agent, a print partner, an admin, a login with no
 *    party at all — keeps the ticket thread they have today. They are not
 *    refused help; they are told where the help is.
 *
 * Lot J2 (4): both reads are the **entitled** ones — running, or ended
 * within the audience policy's `graceDays` (`revenue
 * .entitledSubscriptionForPublisher`, `packages.entitledPackageForAdvertiser`
 * and their batch forms). A term in grace answers entitled with `grace`
 * naming the day it ends, so the door stays open for the copy the policy
 * promised — never for the commission rate, which reads the running row.
 *
 * A login holding both records is entitled if EITHER side pays: the same
 * person asking the same question should not be turned away because the
 * screen they asked from happens to be the publisher one.
 *
 * Every answer carries its reason and an upsell, so the phone can draw the
 * right screen without a second read: the reason names the wall, the upsell
 * names the door. Both are reversible from the console — the tiers and the
 * plan entitlements are settings, not code.
 */

export type EntitlementReason =
  | 'PUBLISHER_SUBSCRIPTION'
  | 'ADVERTISER_PACKAGE'
  | 'NOT_SUBSCRIBED'
  | 'NOT_A_SUBSCRIBER_ROLE'
  | 'PLAN_EXCLUDED'
  | 'FEATURE_OFF';

export type EntitlementPlan = { name: string; tier: string };

export type Entitlement = {
  entitled: boolean;
  reason: EntitlementReason;
  plan: EntitlementPlan | null;
  upsell: { title: string; href: string };
  /** Lot J2: set when the term has ended and the policy's grace still covers it — "in grace until 21 Sept 2026". */
  grace: { until: Date; note: string } | null;
};

/** 21 Sept 2026, as the desk and the phone read it in India. */
const graceNote = (until: Date): string =>
  `in grace until ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(until)}`;

const graceOf = (row: { inGrace: boolean; graceEndsAt: Date | null } | null): Entitlement['grace'] =>
  row && row.inGrace && row.graceEndsAt ? { until: row.graceEndsAt, note: graceNote(row.graceEndsAt) } : null;

const UPSELL = {
  publisher: { title: 'Live chat comes with an ADX subscription', href: '/publisher/subscription' },
  advertiser: { title: 'Live chat comes with an ADX package', href: '/advertiser/packages' },
  none: { title: 'Raise a ticket and ADX will answer', href: '/support/tickets' },
  off: { title: 'Raise a ticket and ADX will answer', href: '/support/tickets' },
} as const;

/** `liveChat: false` on a plan's entitlements JSON excludes it; anything else (absent included) allows. */
export function planAllowsLiveChat(entitlements: unknown): boolean {
  if (!entitlements || typeof entitlements !== 'object') return true;
  return (entitlements as Record<string, unknown>)['liveChat'] !== false;
}

/** The tier gate: an empty `publisherTiers` is every tier. */
export function tierAllowed(tier: string, tiers: readonly string[]): boolean {
  return tiers.length === 0 || tiers.some((allowed) => allowed.toUpperCase() === tier.toUpperCase());
}

export async function liveChatEntitlement(userId: string, now: Date = new Date()): Promise<Entitlement> {
  const settings = await getPlatformSettings();
  const live: LiveChatSettings = settings.support.liveChat;
  if (!live.enabled) return OFF;

  const [publisher, advertiser] = await Promise.all([findPublisherForUser(userId), getAdvertiserForUser(userId)]);
  if (!publisher && !advertiser) return NO_PARTY;

  // Both sides are asked before either refusal is returned: a publisher whose
  // subscription lapsed but whose brand is on a running package is entitled.
  const [subscription, pkg] = await Promise.all([
    publisher ? entitledSubscriptionForPublisher(publisher.id, now) : Promise.resolve(null),
    advertiser ? entitledPackageForAdvertiser(advertiser.id, now) : Promise.resolve(null),
  ]);
  // Lot J-B1: the tier's plan says whether live chat is part of it. One
  // query, and only when there is a subscription to judge.
  const plans = subscription ? await publisherPlansByTier() : null;
  return decide({ publisher: publisher !== null, subscription: withPlan(subscription, plans), pkg: withGrace(pkg) }, live);
}

/** The entitled subscription with its tier's plan beside it — name and entitlements — and its grace, or null. */
function withPlan(
  subscription: { tier: string; inGrace: boolean; graceEndsAt: Date | null } | null,
  plans: Map<string, { name: string; entitlements: unknown }> | null,
): Facts['subscription'] {
  if (!subscription) return null;
  const plan = plans?.get(subscription.tier) ?? null;
  return { tier: subscription.tier, plan: plan ? { name: plan.name, entitlements: plan.entitlements } : null, grace: graceOf(subscription) };
}

/** The entitled package with its grace beside it, or null. */
function withGrace(pkg: { packageName: string; tier: string; entitlements: unknown; inGrace: boolean; graceEndsAt: Date | null } | null): Facts['pkg'] {
  if (!pkg) return null;
  return { packageName: pkg.packageName, tier: pkg.tier, entitlements: pkg.entitlements, grace: graceOf(pkg) };
}

/**
 * The same answer for a set of logins — what the desk's inbox asks, one
 * query per source (the publisher records, the advertiser records, the
 * running subscriptions, the active sales) rather than four per row. An id
 * with no party is in the map as NOT_A_SUBSCRIBER_ROLE, so a caller reads
 * one shape.
 */
export async function liveChatEntitlementsFor(userIds: readonly string[], now: Date = new Date()): Promise<Map<string, Entitlement>> {
  const unique = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const out = new Map<string, Entitlement>();
  if (unique.length === 0) return out;
  const settings = await getPlatformSettings();
  const live: LiveChatSettings = settings.support.liveChat;
  if (!live.enabled) {
    for (const id of unique) out.set(id, OFF);
    return out;
  }

  const [publishers, advertisers] = await Promise.all([findPublisherLabelsForUsers(unique), findAdvertiserLabelsForUsers(unique)]);
  const publisherOf = new Map(publishers.map((row) => [row.userId, row.id]));
  const advertiserOf = new Map(advertisers.map((row) => [row.userId, row.id]));
  const [subscriptions, packages] = await Promise.all([
    publisherOf.size > 0 ? entitledSubscriptionsForPublishers([...publisherOf.values()], now) : Promise.resolve(new Map()),
    advertiserOf.size > 0 ? entitledPackagesForAdvertisers([...advertiserOf.values()], now) : Promise.resolve(new Map()),
  ]);
  // Lot J-B1: the plans once for the page, only when a subscription is on it.
  const plans = subscriptions.size > 0 ? await publisherPlansByTier() : null;

  for (const id of unique) {
    const publisherId = publisherOf.get(id);
    const advertiserId = advertiserOf.get(id);
    if (!publisherId && !advertiserId) {
      out.set(id, NO_PARTY);
      continue;
    }
    out.set(
      id,
      decide(
        {
          publisher: publisherId !== undefined,
          subscription: withPlan(publisherId ? (subscriptions.get(publisherId) ?? null) : null, plans),
          pkg: withGrace(advertiserId ? (packages.get(advertiserId) ?? null) : null),
        },
        live,
      ),
    );
  }
  return out;
}

/** What the desk prints beside a requester: the plan they are on, why it counts (or does not), and (Lot J2) its grace when the term has ended. */
export type PlanOnDesk = { name: string; reason: EntitlementReason; grace: string | null } | null;

export const planOnDesk = (entitlement: Entitlement | undefined): PlanOnDesk =>
  entitlement?.plan ? { name: entitlement.plan.name, reason: entitlement.reason, grace: entitlement.grace?.note ?? null } : null;

const OFF: Entitlement = { entitled: false, reason: 'FEATURE_OFF', plan: null, upsell: UPSELL.off, grace: null };
const NO_PARTY: Entitlement = { entitled: false, reason: 'NOT_A_SUBSCRIBER_ROLE', plan: null, upsell: UPSELL.none, grace: null };

type Facts = {
  /** Whether the login has a publisher record at all — the upsell for a subscriber with nothing running. */
  publisher: boolean;
  /** The entitled subscription and, Lot J-B1, its tier's plan — null when the catalogue has no row for the tier; Lot J2, its grace. */
  subscription: { tier: string; plan: { name: string; entitlements: unknown } | null; grace: Entitlement['grace'] } | null;
  pkg: { packageName: string; tier: string; entitlements: unknown; grace: Entitlement['grace'] } | null;
};

/** What the desk prints for a publisher: the plan's own name when the catalogue has one, the tier otherwise. */
const publisherPlanName = (subscription: NonNullable<Facts['subscription']>): string =>
  subscription.plan ? `${subscription.plan.name} plan` : `${titleCase(subscription.tier)} subscription`;

/** The rule itself, shared by the single and the batch read so the two can never disagree. */
function decide({ publisher, subscription, pkg }: Facts, live: LiveChatSettings): Entitlement {
  // Lot J-B1: the plan's entitlements first, then the settings' narrowing. A
  // tier with no catalogue row is judged by the settings alone, as before.
  if (
    subscription &&
    planAllowsLiveChat(subscription.plan?.entitlements) &&
    tierAllowed(subscription.tier, live.publisherTiers)
  ) {
    return {
      entitled: true,
      reason: 'PUBLISHER_SUBSCRIPTION',
      plan: { name: publisherPlanName(subscription), tier: subscription.tier },
      upsell: UPSELL.publisher,
      grace: subscription.grace,
    };
  }
  if (pkg && planAllowsLiveChat(pkg.entitlements)) {
    return {
      entitled: true,
      reason: 'ADVERTISER_PACKAGE',
      plan: { name: pkg.packageName, tier: pkg.tier },
      upsell: UPSELL.advertiser,
      grace: pkg.grace,
    };
  }

  // Paying, but on something this feature is not part of — a tier the
  // settings leave out, or a plan whose entitlements say no.
  if (subscription) {
    return {
      entitled: false,
      reason: 'PLAN_EXCLUDED',
      plan: { name: publisherPlanName(subscription), tier: subscription.tier },
      upsell: UPSELL.publisher,
      grace: subscription.grace,
    };
  }
  if (pkg) {
    return { entitled: false, reason: 'PLAN_EXCLUDED', plan: { name: pkg.packageName, tier: pkg.tier }, upsell: UPSELL.advertiser, grace: pkg.grace };
  }
  return {
    entitled: false,
    reason: 'NOT_SUBSCRIBED',
    plan: null,
    upsell: publisher ? UPSELL.publisher : UPSELL.advertiser,
    grace: null,
  };
}

const titleCase = (value: string): string => value.charAt(0) + value.slice(1).toLowerCase();
