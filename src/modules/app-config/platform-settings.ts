import { z } from 'zod';
import { invalidate, readThrough } from '../../shared/cache';
import { getConfigObject, saveConfigObject } from './app-config.service';

/**
 * The platform settings row — Lot A, Q31.
 *
 * One `AppConfig` row keyed `platform`, holding the handful of numbers other
 * modules read on their hot paths: the KYC review SLA, whether a verified
 * listing goes live on its own, the marketplace floors, the retention
 * windows, the support SLAs. Kept as a document rather than a table for the
 * same reason `app-status` is: it is one small thing ops edit, not a set of
 * records.
 *
 * Every reader goes through `getPlatformSettings()`, which is cached for a
 * minute in Redis and invalidated by the PUT, so the queue, the checkout and
 * the verification desk never pay a database read for a number that changes
 * once a quarter. A row that fails to parse — half-written by hand, or from
 * a build with a different shape — is served as the defaults rather than as a
 * partial object, because a missing floor is safer than an undefined one.
 */

export const PLATFORM_SETTINGS_KEY = 'platform';
export const PLATFORM_SETTINGS_CACHE_KEY = 'app-config:platform';
export const PLATFORM_SETTINGS_TTL_SECONDS = 60;

export const SUPPORT_PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const PAYOUT_RAILS = ['MANUAL_NEFT', 'RAZORPAY_X', 'CASHFREE'] as const;
const payoutRailSchema = z.enum(PAYOUT_RAILS);

const slaSchema = z.object({
  firstResponseHours: z.number().int().min(1).max(24 * 30),
  resolutionHours: z.number().int().min(1).max(24 * 90),
});

/** `HH:mm`, 24-hour. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm');

/**
 * Lot G (Q124): the weekly payout draft. `weekday` is 0–6 with Sunday 0 (the
 * JavaScript convention), `hourIst` the Indian hour the job drafts at.
 */
const payoutBatchCadenceSchema = z.object({
  enabled: z.boolean(),
  weekday: z.number().int().min(0).max(6),
  hourIst: z.number().int().min(0).max(23),
});

/**
 * Lot G (Q117): when a non-transactional message may not leave, and how many
 * a person gets a week. Transactional copy (an OTP, a payment, a decision)
 * ignores both.
 */
const quietHoursSchema = z.object({
  from: clockTime,
  to: clockTime,
  /** An IANA zone; the platform is India-only, so the default is Asia/Kolkata. */
  tz: z.string().trim().min(1).max(64),
});

/**
 * Lot I: live chat for paid subscribers. `hours` is the window the desk
 * answers live (outside it a message becomes a ticket with the next opening
 * promised); `firstResponseTargetSec` is the live SLA the inbox and the
 * sweep judge a chat by; `publisherTiers` narrows which publisher tiers are
 * entitled (empty = every running subscription); `attachmentMaxMb` caps an
 * image or PDF on a message. `enabled` is ops' own switch beside the
 * `support.live-chat` kill switch — off, every phone is told NOT entitled
 * (FEATURE_OFF) and keeps the ticket thread.
 */
const liveChatHoursSchema = z.object({
  from: clockTime,
  to: clockTime,
  tz: z.string().trim().min(1).max(64),
});
const liveChatSchema = z.object({
  enabled: z.boolean(),
  hours: liveChatHoursSchema,
  firstResponseTargetSec: z.number().int().min(10).max(3600),
  publisherTiers: z.array(z.string().trim().min(1).max(40)).max(10),
  attachmentMaxMb: z.number().int().min(1).max(10),
});
export type LiveChatSettings = z.infer<typeof liveChatSchema>;

/**
 * Lot J2 (the owner, 14 Sep 2026): the purchase rules for a subscription,
 * one policy per audience — `subscriptions.publisher` for the plans
 * `revenue` sells and `subscriptions.advertiser` for the packages
 * `packages` sells. Every default is today's behaviour, so nothing changed
 * on the day this landed; the console changes it from here on. GST is NOT
 * here: both pricing paths read `revenue`'s `TaxSettings.mediaGstPct`.
 */
export const SUBSCRIPTION_CYCLES = ['MONTHLY', 'ANNUAL'] as const;
export type SubscriptionCycle = (typeof SUBSCRIPTION_CYCLES)[number];
export const SUBSCRIPTION_CHANGE_POLICIES = ['REPLACE_NOW', 'QUEUE_AFTER_TERM'] as const;
export type SubscriptionChangePolicy = (typeof SUBSCRIPTION_CHANGE_POLICIES)[number];
/** The gateways `payments` exposes — the Prisma `PaymentGateway` enum, spelled here so the schema needs no module import. */
export const PAYMENT_GATEWAYS = ['RAZORPAY', 'CASHFREE', 'CCAVENUE'] as const;
export type SubscriptionPaymentGateway = (typeof PAYMENT_GATEWAYS)[number];
export const SUBSCRIPTION_AUDIENCES = ['publisher', 'advertiser'] as const;
export type SubscriptionAudience = (typeof SUBSCRIPTION_AUDIENCES)[number];

const tierKey = z.string().trim().min(1).max(40).regex(/^[A-Z][A-Z0-9_]*$/, 'A tier is UPPER_SNAKE_CASE');
const days90 = z.number().int().min(0).max(90);

const subscriptionPaymentSchema = z.object({
  /** The party's own ADX wallet. */
  walletAllowed: z.boolean(),
  /** An empty list closes the gateway path for this audience. */
  gatewaysAllowed: z.array(z.enum(PAYMENT_GATEWAYS)).max(PAYMENT_GATEWAYS.length),
});
const subscriptionAutoRenewSchema = z.object({
  allowed: z.boolean(),
  /** The only rail a renewal charges today; stated so the console shows it. */
  chargeFromWallet: z.literal(true),
});
const subscriptionPolicySchema = z.object({
  cyclesOffered: z.array(z.enum(SUBSCRIPTION_CYCLES)).min(1).max(SUBSCRIPTION_CYCLES.length),
  /** Off twelve months bought at once — the SAVE 20% badge. */
  annualDiscountPct: z.number().min(0).max(90),
  /** What a different tier does to the running one. */
  changePolicy: z.enum(SUBSCRIPTION_CHANGE_POLICIES),
  /** REPLACE_NOW only: the unused days of the replaced term come back as wallet credit. */
  prorateOnChange: z.boolean(),
  /** Entitlements (live chat and the other copy keys — never the commission rate) survive this many days after `endsAt`. */
  graceDays: days90,
  /** Per tier: a first-ever subscriber may start this many free days; 0 is no trial. */
  trialDays: z.record(tierKey, days90),
  reminderLeadDays: z.number().int().min(1).max(30),
  unpaidOrderExpiryDays: z.number().int().min(1).max(30),
  payment: subscriptionPaymentSchema,
  autoRenew: subscriptionAutoRenewSchema,
});
export type SubscriptionPolicy = z.infer<typeof subscriptionPolicySchema>;

/**
 * Lot K2: the authenticator-app policy. `authenticatorRequired` — an admin
 * with no enrolment signs in (SMS or email, as today) into a "must enrol"
 * state: the tokens carry `mustEnrolAuthenticator` and every route but the
 * enrolment ones answers 403 TOTP_ENROLMENT_REQUIRED. `smsAllowedWhenEnrolled`
 * off — an enrolled admin's challenge lists AUTHENTICATOR only; a recovery
 * code always works.
 */
const adminTwoFactorSchema = z.object({
  authenticatorRequired: z.boolean(),
  smsAllowedWhenEnrolled: z.boolean(),
});
export type AdminTwoFactorPolicy = z.infer<typeof adminTwoFactorSchema>;

const workloadThresholdsSchema = z
  .object({
    /** Items per week at which a staffer's load reads MEDIUM. */
    medium: z.number().min(0),
    /** Items per week at which it reads HIGH. */
    high: z.number().min(0),
  })
  .refine((value) => value.high > value.medium, { message: 'high must be above medium', path: ['high'] });

export const platformSettingsSchema = z.object({
  kyc: z.object({
    /** Hours from submission before a pending review counts as breached. */
    reviewSlaHours: z.number().int().min(1).max(24 * 30),
    /** Lot G (Q127/142): a PENDING case older than this many SLAs is escalated to Compliance by the nightly job. */
    escalationSlaMultiplier: z.number().min(1).max(30),
    /**
     * Lot N: whether `POST /print-partners/:id/activate` needs the partner's
     * KYC VERIFIED first (409 KYC_REQUIRED otherwise). Off by default — the
     * behaviour before the print-partner KYC record existed: ops activate,
     * KYC follows.
     */
    printPartnerActivationRequiresKyc: z.boolean(),
  }),
  /** Lot G (Q118/138): the nightly signal scan — a signal above the threshold opens a case; each party type is walked up to the limit. */
  fraud: z.object({
    scanThreshold: z.number().min(0).max(1),
    scanLimitPerType: z.number().int().min(1).max(20_000),
  }),
  listings: z.object({
    /** A first accepted site verification takes the listing ACTIVE on its own. */
    autoPublishOnVerification: z.boolean(),
  }),
  marketplace: z.object({
    /** The floor under every listing's own `minBookingDays`. */
    minBookingDays: z.number().int().min(1).max(365),
    maxMarketsPerCampaign: z.number().int().min(1).max(50),
  }),
  publisher: z.object({
    spotInsightsVisible: z.boolean(),
  }),
  retention: z.object({
    financialYears: z.number().int().min(1).max(30),
    kycYears: z.number().int().min(1).max(30),
  }),
  support: z.object({
    sla: z.object({
      URGENT: slaSchema,
      HIGH: slaSchema,
      NORMAL: slaSchema,
      LOW: slaSchema,
    }),
    liveChat: liveChatSchema,
  }),
  auth: z.object({
    adminPasswordLoginEnabled: z.boolean(),
    /** Lot K2: the authenticator app as an admin's second factor. */
    adminTwoFactor: adminTwoFactorSchema,
  }),
  installation: z.object({
    commissionMode: z.enum(['FLAT', 'PER_ORDER']),
  }),
  /**
   * Lot B (Q85): the payout rails and the clearing window. One platform-wide
   * primary rail; the fallback order is walked when it is not configured, and
   * the manual rail is always last and always available whatever is listed.
   */
  finance: z.object({
    primaryRail: payoutRailSchema,
    railFallbackOrder: z.array(payoutRailSchema).max(3),
    /** What the party is told to expect between release and the bank line. */
    payoutEtaHours: z.number().int().min(1).max(24 * 14),
    /** Days a daily earning waits before it can be withdrawn. */
    clearingDays: z.number().int().min(0).max(60),
    /**
     * Lot C (Q88): a campaign total at or above this needs a second admin
     * when ops authorise on the advertiser's behalf (409 FOUR_EYES otherwise).
     */
    opsAuthoriseThreshold: z.number().min(0),
    /** Lot G (Q124): the weekly draft batch — a job drafts, a person releases. */
    payoutBatchCadence: payoutBatchCadenceSchema,
  }),
  /** Lot G (Q117): the dispatcher's quiet hours and weekly cap for non-transactional copy. */
  comms: z.object({
    quietHours: quietHoursSchema,
    /** Non-transactional deliveries one person receives per Indian week, all channels together. */
    weeklyCapPerUser: z.number().int().min(0).max(1000),
  }),
  /**
   * Lot G (Q112): the dashboard's rule-based insights. Each number is the
   * threshold of one rule — see `admin-overview/README.md` for the rules.
   */
  insights: z.object({
    /** A month-on-month GMV fall at or past this many percent reads WARN. */
    gmvDropWarnPct: z.number().min(0).max(100),
    /** ... and at or past this many, CRITICAL. */
    gmvDropCriticalPct: z.number().min(0).max(100),
    /** An APPROVED withdrawal older than this, unreleased, is waiting on finance. */
    withdrawalReleaseHours: z.number().int().min(1).max(24 * 30),
    /** A fraud case still open after this many days is stale. */
    fraudOpenDays: z.number().int().min(1).max(365),
    /** A below-floor listing whose grace ends within this many days is about to be unpublished. */
    floorGraceDays: z.number().int().min(1).max(60),
    /** A PENDING_PAYMENT campaign whose spot hold ends within this many hours is about to lose its inventory. */
    paymentHoldHours: z.number().int().min(1).max(72),
    /** A count-rule at or past this many reads CRITICAL rather than WARN. */
    criticalCount: z.number().int().min(1).max(10_000),
  }),
  /**
   * Lot G (Q120/Q139): the workload chart's bands. A staffer's load is a
   * weighted count of open items and actions, normalised to a week; below
   * `medium` is LOW, from `medium` MEDIUM, from `high` HIGH.
   */
  hr: z.object({
    workloadThresholds: workloadThresholdsSchema,
  }),
  /** Lot G (Q130): what the status page calls degraded — read by `ops` over the five-minute samples. */
  health: z.object({
    /** An API sample whose p95 is above this is DEGRADED even though it answered. */
    apiP95DegradedMs: z.number().int().min(100).max(60_000),
    /** A service whose newest sample is older than this reads UNKNOWN: the sampler itself has stopped. */
    sampleStaleMinutes: z.number().int().min(5).max(24 * 60),
  }),
  /** Lot J2: the purchase rules, one policy per audience — see `SubscriptionPolicy`. */
  subscriptions: z.object({
    publisher: subscriptionPolicySchema,
    advertiser: subscriptionPolicySchema,
  }),
  /**
   * Lot V (the owner, 15 Sep 2026): the city rollout. `launchMinListings`
   * and `launchNeedsPrintPartner` are what `GET /geo/cities/:slug/readiness`
   * checks before ops launch a city; `comingSoonWaitlist` is whether the
   * app's pickers list SEEDING cities and PLANNED capitals as "coming soon"
   * for the advertiser waitlist.
   */
  geo: z.object({
    launchMinListings: z.number().int().min(0).max(10_000),
    launchNeedsPrintPartner: z.boolean(),
    comingSoonWaitlist: z.boolean(),
  }),
  /**
   * Y-B: the city audience profile (`GET /geo/cities/:slug/audience`) folds
   * what the spot reads already fetched and calls no vendor — unless
   * `cityProfileSamplePoints` is above 0, in which case up to that many grid
   * points across the city are asked once per month per enabled vendor and
   * kept as snapshots. Each point is a billable vendor call per vendor per
   * month per city: 16 points × 2 vendors × 50 cities is 1,600 calls a month.
   */
  audience: z.object({
    cityProfileSamplePoints: z.number().int().min(0).max(64),
  }),
});

export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  kyc: { reviewSlaHours: 48, escalationSlaMultiplier: 2, printPartnerActivationRequiresKyc: false },
  fraud: { scanThreshold: 0.6, scanLimitPerType: 500 },
  listings: { autoPublishOnVerification: true },
  marketplace: { minBookingDays: 1, maxMarketsPerCampaign: 3 },
  publisher: { spotInsightsVisible: false },
  retention: { financialYears: 8, kycYears: 8 },
  support: {
    sla: {
      URGENT: { firstResponseHours: 1, resolutionHours: 4 },
      HIGH: { firstResponseHours: 4, resolutionHours: 24 },
      NORMAL: { firstResponseHours: 8, resolutionHours: 72 },
      LOW: { firstResponseHours: 24, resolutionHours: 168 },
    },
    liveChat: {
      enabled: true,
      hours: { from: '09:00', to: '21:00', tz: 'Asia/Kolkata' },
      firstResponseTargetSec: 120,
      publisherTiers: [],
      attachmentMaxMb: 10,
    },
  },
  auth: { adminPasswordLoginEnabled: true, adminTwoFactor: { authenticatorRequired: false, smsAllowedWhenEnrolled: true } },
  installation: { commissionMode: 'FLAT' },
  finance: {
    primaryRail: 'MANUAL_NEFT',
    railFallbackOrder: ['RAZORPAY_X', 'CASHFREE', 'MANUAL_NEFT'],
    payoutEtaHours: 48,
    clearingDays: 7,
    opsAuthoriseThreshold: 50_000,
    payoutBatchCadence: { enabled: true, weekday: 1, hourIst: 10 },
  },
  comms: {
    quietHours: { from: '21:00', to: '08:00', tz: 'Asia/Kolkata' },
    weeklyCapPerUser: 5,
  },
  insights: {
    gmvDropWarnPct: 10,
    gmvDropCriticalPct: 30,
    withdrawalReleaseHours: 48,
    fraudOpenDays: 7,
    floorGraceDays: 3,
    paymentHoldHours: 2,
    criticalCount: 10,
  },
  hr: { workloadThresholds: { medium: 10, high: 25 } },
  health: { apiP95DegradedMs: 1500, sampleStaleMinutes: 15 },
  subscriptions: {
    publisher: {
      cyclesOffered: ['MONTHLY', 'ANNUAL'],
      annualDiscountPct: 20,
      changePolicy: 'REPLACE_NOW',
      prorateOnChange: false,
      graceDays: 0,
      trialDays: { STANDARD: 0, PLUS: 0, PRO: 0 },
      reminderLeadDays: 7,
      unpaidOrderExpiryDays: 7,
      payment: { walletAllowed: true, gatewaysAllowed: [...PAYMENT_GATEWAYS] },
      autoRenew: { allowed: false, chargeFromWallet: true },
    },
    advertiser: {
      cyclesOffered: ['MONTHLY', 'ANNUAL'],
      annualDiscountPct: 20,
      changePolicy: 'REPLACE_NOW',
      prorateOnChange: false,
      graceDays: 0,
      trialDays: { STARTER: 0, GROWTH: 0, PRO: 0 },
      reminderLeadDays: 7,
      unpaidOrderExpiryDays: 7,
      payment: { walletAllowed: true, gatewaysAllowed: [...PAYMENT_GATEWAYS] },
      autoRenew: { allowed: false, chargeFromWallet: true },
    },
  },
  geo: { launchMinListings: 10, launchNeedsPrintPartner: false, comingSoonWaitlist: true },
  audience: { cityProfileSamplePoints: 0 },
};

/**
 * What a PUT may carry: any subset of the sections, each any subset of its
 * fields. Unknown keys are refused rather than stored, so a typo in a section
 * name cannot sit in the row forever doing nothing.
 */
const sections = platformSettingsSchema.shape;
const slaPatch = slaSchema.partial();
/** Lot J2: any subset of a policy; `trialDays` is merged tier by tier, `cyclesOffered` and `gatewaysAllowed` replace whole. */
const subscriptionPolicyPatch = subscriptionPolicySchema
  .partial()
  .strict()
  .extend({
    payment: subscriptionPaymentSchema.partial().strict().optional(),
    autoRenew: subscriptionAutoRenewSchema.partial().strict().optional(),
  });
export const platformSettingsPatchSchema = z.strictObject({
  kyc: sections.kyc.partial().strict().optional(),
  fraud: sections.fraud.partial().strict().optional(),
  listings: sections.listings.partial().strict().optional(),
  marketplace: sections.marketplace.partial().strict().optional(),
  publisher: sections.publisher.partial().strict().optional(),
  retention: sections.retention.partial().strict().optional(),
  support: z
    .strictObject({
      sla: z
        .strictObject({ URGENT: slaPatch, HIGH: slaPatch, NORMAL: slaPatch, LOW: slaPatch })
        .partial()
        .optional(),
      liveChat: liveChatSchema.partial().strict().extend({ hours: liveChatHoursSchema.partial().strict().optional() }).optional(),
    })
    .optional(),
  auth: sections.auth
    .partial()
    .strict()
    .extend({ adminTwoFactor: adminTwoFactorSchema.partial().strict().optional() })
    .optional(),
  installation: sections.installation.partial().strict().optional(),
  finance: sections.finance
    .partial()
    .strict()
    .extend({ payoutBatchCadence: payoutBatchCadenceSchema.partial().strict().optional() })
    .optional(),
  comms: sections.comms
    .partial()
    .strict()
    .extend({ quietHours: quietHoursSchema.partial().strict().optional() })
    .optional(),
  insights: sections.insights.partial().strict().optional(),
  hr: z
    .strictObject({ workloadThresholds: z.strictObject({ medium: z.number().min(0).optional(), high: z.number().min(0).optional() }).optional() })
    .optional(),
  health: sections.health.partial().strict().optional(),
  subscriptions: z
    .strictObject({ publisher: subscriptionPolicyPatch.optional(), advertiser: subscriptionPolicyPatch.optional() })
    .optional(),
  geo: sections.geo.partial().strict().optional(),
  audience: sections.audience.partial().strict().optional(),
});
export type PlatformSettingsPatch = z.infer<typeof platformSettingsPatchSchema>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `patch` laid over `base`, object by object; a scalar or array in the patch replaces. */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value;
  }
  return out as T;
}

/** The stored row, parsed; the defaults when there is none or it does not parse. */
async function loadPlatformSettings(): Promise<PlatformSettings> {
  const row = await getConfigObject(PLATFORM_SETTINGS_KEY);
  if (!row) return DEFAULT_PLATFORM_SETTINGS;
  // Laid over the defaults first so a row written before a section existed
  // still answers for that section.
  const parsed = platformSettingsSchema.safeParse(deepMerge(DEFAULT_PLATFORM_SETTINGS, row));
  return parsed.success ? parsed.data : DEFAULT_PLATFORM_SETTINGS;
}

/** What every other module reads. Cached a minute; the PUT invalidates. */
export async function getPlatformSettings(): Promise<PlatformSettings> {
  return readThrough(PLATFORM_SETTINGS_CACHE_KEY, PLATFORM_SETTINGS_TTL_SECONDS, loadPlatformSettings);
}

/**
 * A partial deep-merge over the current row. Returns both sides so the
 * caller can audit the difference; the stored row is always the whole,
 * validated document, never the patch.
 */
export async function updatePlatformSettings(
  patch: PlatformSettingsPatch,
): Promise<{ before: PlatformSettings; after: PlatformSettings }> {
  const before = await loadPlatformSettings();
  const after = platformSettingsSchema.parse(deepMerge(before, patch as Record<string, unknown>));
  await saveConfigObject(PLATFORM_SETTINGS_KEY, after);
  await invalidate(PLATFORM_SETTINGS_CACHE_KEY);
  return { before, after };
}

/**
 * The document as dotted leaves — `kyc.reviewSlaHours: 48` — so an audit
 * diff names the field that moved rather than the whole section it sits in.
 */
export function flattenSettings(value: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(item)) Object.assign(out, flattenSettings(item, path));
    else out[path] = item;
  }
  return out;
}

/**
 * Lot J2: one audience's purchase rules — what `revenue` (publisher) and
 * `packages` (advertiser) read on every quote, activation and sweep. The
 * same cached read as `getPlatformSettings()`, narrowed.
 */
export async function getSubscriptionPolicy(audience: SubscriptionAudience): Promise<SubscriptionPolicy> {
  return (await getPlatformSettings()).subscriptions[audience];
}
