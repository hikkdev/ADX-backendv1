import { randomBytes, randomInt } from 'crypto';
import { env } from '../../config/env';
import { ApiError } from '../../shared/errors';
import { toListPage } from '../../shared/pagination';
import { EXPIRING_WITHIN_DAYS, type ListSalesQuery } from './packages.schema';
import { Decimal, money, type Money } from '../../shared/money';
import { logger } from '../../shared/logging';
import { auditDiff, logActivity } from '../../shared/audit';
import type { Prisma } from '../../shared/database';
import type { Request } from 'express';
import { liveGrantFor } from '../access-grants';
import { bookingEligibility, payForPackage } from '../advertisers';
import { currentTemplate, recordAcceptance, transactionAcceptance, type AcceptanceContext, type AgreementStanding } from '../agreements';
import { getSubscriptionPolicy, type SubscriptionPolicy } from '../app-config';
import { createNotification, notify } from '../notifications';
import { recordIncentive } from '../payouts';
import { assertCycleOffered, fractionToPercent, policyView, prorationAmount, taxSettings, type PolicyView, type PricingRates, type Proration } from '../revenue';
import { assertVisitOutcome } from '../visits';
import { ensureWallet, move } from '../wallets';
import { prismaPackagesRepository as repository } from './prisma-packages.repository';
import type { AddOnPatch, AddOnRow, PackageRow, PlanPatch, SaleRow } from './packages.repository';
import { packageInvoicing } from './invoicing.port';

/**
 * Selling a package — DR 02's four-step sales flow.
 *
 * The shape of this module is decided by its third screen. The agent does not
 * take the money: a link goes to the advertiser and the agent waits. So a sale
 * exists as a record before it is paid for, it carries a token somebody else
 * opens, and its term starts when the money lands rather than when the wizard
 * finished. Everything here follows from that.
 *
 * What a package *entitles* an advertiser to is named on the plan and enforced
 * nowhere. That is deliberate rather than unfinished: the frames name three
 * add-ons and no rule anywhere in the platform reads them, so pretending a gate
 * exists would be the kind of screen that looks like configuration and changes
 * nothing. The entitlements are returned by the API for whoever builds those
 * gates; until then a package is a commercial record, and it says so.
 *
 * DR 06 decision 16: "₹2,500 comm." on the agent's package-sale card had no
 * source. A paid sale now records a PACKAGE_SOLD incentive for the agent who
 * sold it — priced in the rate table, at their tier, landing
 * PENDING_VERIFICATION — and keeps the incentive's id, so the card's figure is
 * the wallet's figure. A sale nobody sold records nothing, and a tier with no
 * rate is still paid for; the card prints nothing rather than zero.
 *
 * Lot J2 (the owner, 14 Sep 2026): the purchase rules are configuration —
 * `settings.subscriptions.advertiser` (`app-config`), read on every quote,
 * activation and sweep: the cycles offered and the annual discount, what a
 * different tier does to the running one (replace now, with or without a
 * proration credit, or queue after the term), a grace window on the
 * entitlements, per-tier free trials, the reminder lead, which rails may
 * pay, and auto-renew from the wallet. GST is not a policy field: the
 * quote reads revenue's own tax row, the one `PATCH /revenue/tax` sets.
 */

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

/**
 * The three plans and three add-ons DR 02 draws, seeded on first read.
 *
 * Seeded rather than hardcoded so ops can reprice without a deploy — and
 * snapshotted onto each sale, so repricing never re-rates a sale already made.
 */
const CATALOGUE = [
  {
    tier: 'STARTER' as const,
    name: 'Starter',
    pricePerMonth: '9999',
    description: 'For one brand finding its feet.',
    isPopular: false,
    sortOrder: 1,
    entitlements: { campaignsPerMonth: 2, creativeRefreshes: 1, support: 'STANDARD' },
  },
  {
    tier: 'GROWTH' as const,
    name: 'Growth',
    pricePerMonth: '24999',
    description: 'For a brand running campaigns every month.',
    isPopular: true,
    sortOrder: 2,
    entitlements: { campaignsPerMonth: 8, creativeRefreshes: 3, support: 'PRIORITY' },
  },
  {
    tier: 'PRO' as const,
    name: 'Pro',
    pricePerMonth: '49999',
    description: 'For an agency or a brand running several at once.',
    isPopular: false,
    sortOrder: 3,
    entitlements: { campaignsPerMonth: null, creativeRefreshes: 10, support: 'DEDICATED' },
  },
];

const ADD_ONS = [
  {
    code: 'EXTRA_CREATIVE_REFRESH',
    name: 'Extra creative refresh',
    pricePerMonth: '3000',
    description: 'More AI drafts of a campaign creative each month.',
    sortOrder: 1,
  },
  {
    code: 'PREMIUM_ANALYTICS',
    name: 'Premium analytics',
    pricePerMonth: '2500',
    description: 'Longer history and per-site breakdowns.',
    sortOrder: 2,
  },
  {
    code: 'DEDICATED_SUPPORT_MANAGER',
    name: 'Dedicated support manager',
    pricePerMonth: '5000',
    description: 'A named person who answers first.',
    sortOrder: 3,
  },
];

/** Creates the catalogue if it is empty. Idempotent, and safe to call per request. */
export async function ensureCatalogue(): Promise<void> {
  const existing = await repository.listPackages(true);
  if (existing.length === 0) {
    for (const plan of CATALOGUE) {
      await repository.upsertPackage({
        tier: plan.tier,
        name: plan.name,
        pricePerMonth: new Decimal(plan.pricePerMonth),
        description: plan.description,
        isPopular: plan.isPopular,
        entitlements: plan.entitlements,
        sortOrder: plan.sortOrder,
      });
    }
  }

  const addOns = await repository.listAddOns(true);
  if (addOns.length === 0) {
    for (const addOn of ADD_ONS) {
      await repository.upsertAddOn({
        code: addOn.code,
        name: addOn.name,
        pricePerMonth: new Decimal(addOn.pricePerMonth),
        description: addOn.description,
        sortOrder: addOn.sortOrder,
      });
    }
  }
}

/**
 * The catalogue read. Active rows only by default — the agent app's step 1 —
 * and, for the console's editor (E7-3), `includeInactive` lists the retired
 * plans and add-ons beside them so they can be switched back on. Every row
 * carries `isActive` and `sortOrder` either way.
 */
export async function listCatalogue(options: { includeInactive?: boolean | undefined } = {}) {
  await ensureCatalogue();
  const includeInactive = options.includeInactive === true;
  const [packages, addOns] = await Promise.all([
    repository.listPackages(includeInactive),
    repository.listAddOns(includeInactive),
  ]);
  return {
    packages: packages.map((plan) => ({
      id: plan.id,
      tier: plan.tier,
      name: plan.name,
      pricePerMonth: money(plan.pricePerMonth),
      description: plan.description,
      isPopular: plan.isPopular,
      entitlements: plan.entitlements,
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
    })),
    addOns: addOns.map((addOn) => ({
      id: addOn.id,
      code: addOn.code,
      name: addOn.name,
      pricePerMonth: money(addOn.pricePerMonth),
      description: addOn.description,
      isActive: addOn.isActive,
      sortOrder: addOn.sortOrder,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Lot D (Q94): the catalogue editor                                   */
/* ------------------------------------------------------------------ */

/*
 * Ops reprice and rename without a deploy. Two things hold: every sale
 * already made keeps the snapshot it was priced on (`PackageSale.tier`,
 * `packageName`, `pricePerMonth` and its lines are copies, never joins), so
 * an edit here only ever changes the next sale; and entitlements stay copy —
 * named on the card, enforced nowhere, exactly as the header of this file
 * says. The editor is the place that copy is written, not a place a gate
 * appears. Both writes are audited with the diff on the money and the switch.
 */

type Editor = { userId: string; req?: Request | undefined };

const decimalOrUndefined = (value: string | undefined) => (value === undefined ? undefined : new Decimal(value));

export async function updatePlan(
  tier: PackageRow['tier'],
  patch: {
    name?: string | undefined;
    pricePerMonth?: string | undefined;
    description?: string | null | undefined;
    isPopular?: boolean | undefined;
    entitlements?: Record<string, unknown> | undefined;
    isActive?: boolean | undefined;
    sortOrder?: number | undefined;
  },
  editor: Editor,
): Promise<PackageRow> {
  await ensureCatalogue();
  const before = await repository.findPackageByTier(tier);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Plan not found');

  const clean: PlanPatch = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.pricePerMonth !== undefined ? { pricePerMonth: decimalOrUndefined(patch.pricePerMonth) } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.isPopular !== undefined ? { isPopular: patch.isPopular } : {}),
    ...(patch.entitlements !== undefined ? { entitlements: patch.entitlements as Prisma.InputJsonValue } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
  };
  const after = await repository.updatePackage(tier, clean);

  await logActivity(editor.userId, 'PACKAGE_PLAN_UPDATED', {
    req: editor.req,
    module: 'packages',
    targetType: 'AdvertiserPackage',
    targetId: after.id,
    diff: auditDiff(
      { name: before.name, pricePerMonth: money(before.pricePerMonth), isActive: before.isActive, isPopular: before.isPopular, entitlements: before.entitlements },
      { name: after.name, pricePerMonth: money(after.pricePerMonth), isActive: after.isActive, isPopular: after.isPopular, entitlements: after.entitlements },
    ),
    metadata: { tier },
  });
  return after;
}

export async function createAddOn(
  input: { code: string; name: string; pricePerMonth: string; description?: string | null | undefined; sortOrder?: number | undefined },
  editor: Editor,
): Promise<AddOnRow> {
  await ensureCatalogue();
  if (await repository.findAddOnByCode(input.code)) {
    throw new ApiError(409, 'CONFLICT', `An add-on with code ${input.code} already exists. Edit it instead.`);
  }
  const created = await repository.upsertAddOn({
    code: input.code,
    name: input.name,
    pricePerMonth: new Decimal(input.pricePerMonth),
    description: input.description ?? null,
    sortOrder: input.sortOrder ?? 0,
  });
  await logActivity(editor.userId, 'PACKAGE_ADDON_CREATED', {
    req: editor.req,
    module: 'packages',
    targetType: 'PackageAddOn',
    targetId: created.id,
    diff: auditDiff(null, { code: created.code, name: created.name, pricePerMonth: money(created.pricePerMonth), isActive: created.isActive }),
  });
  return created;
}

export async function updateAddOn(
  code: string,
  patch: {
    name?: string | undefined;
    pricePerMonth?: string | undefined;
    description?: string | null | undefined;
    isActive?: boolean | undefined;
    sortOrder?: number | undefined;
  },
  editor: Editor,
): Promise<AddOnRow> {
  const before = await repository.findAddOnByCode(code);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Add-on not found');
  const clean: AddOnPatch = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.pricePerMonth !== undefined ? { pricePerMonth: decimalOrUndefined(patch.pricePerMonth) } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
  };
  const after = await repository.updateAddOn(code, clean);
  await logActivity(editor.userId, 'PACKAGE_ADDON_UPDATED', {
    req: editor.req,
    module: 'packages',
    targetType: 'PackageAddOn',
    targetId: after.id,
    diff: auditDiff(
      { name: before.name, pricePerMonth: money(before.pricePerMonth), isActive: before.isActive },
      { name: after.name, pricePerMonth: money(after.pricePerMonth), isActive: after.isActive },
    ),
    metadata: { code },
  });
  return after;
}

/* ------------------------------------------------------------------ */
/* Lot D (Q123): the package terms                                     */
/* ------------------------------------------------------------------ */

/**
 * Renders the package terms for one sale: the live PACKAGE_SALE template
 * with the sale enumerated — plan, cycle, every line and the total —
 * exactly as the advertiser accepts them. `{{sale}}` in the body is
 * replaced; without it the schedule is appended.
 */
export function renderPackageTerms(body: string, sale: SaleRow): string {
  const schedule = [
    `Package ${sale.reference} — ${sale.packageName} (${sale.tier})`,
    `Advertiser: ${sale.advertiser.companyName ?? sale.advertiser.name}`,
    `Cycle: ${sale.cycle}, ${sale.months} month${sale.months === 1 ? '' : 's'}`,
    '',
    ...sale.lines.map((line, index) => `${index + 1}. ${line.label} — ₹${money(line.pricePerMonth)}/month × ${line.months} = ₹${money(line.amount)}`),
    '',
    `Subtotal ₹${money(sale.subtotal)}; discount ₹${money(sale.discountAmount)}; GST ₹${money(sale.gstAmount)}; total ₹${money(sale.total)}`,
  ].join('\n');
  return body.includes('{{sale}}')
    ? body.replace('{{sale}}', schedule)
    : `${body}\n\n## This order\n\n${schedule}`;
}

/**
 * Who may accept the package terms: the advertiser the sale is for, or an
 * agent holding a live PROFILE grant on that advertiser — the agent acting
 * for them, under a code the advertiser approved. Not an admin: ADX cannot
 * accept its own terms on the buyer's behalf. The acceptance always names
 * the advertiser as the party; the click's user is whoever tapped.
 */
export async function assertMayAcceptTerms(sale: SaleRow, actor: SaleActor): Promise<void> {
  if (actor.advertiserId && actor.advertiserId === sale.advertiserId) return;
  if (actor.agentId) {
    const grant = await liveGrantFor(actor.agentId, { advertiserId: sale.advertiserId }, 'PROFILE');
    if (grant) return;
    throw new ApiError(403, 'FORBIDDEN', 'Your access to this advertiser has ended. Ask them to approve a fresh code.');
  }
  throw new ApiError(403, 'FORBIDDEN', 'Only the advertiser, or their agent under a live grant, can accept the package terms.');
}

/**
 * The advertiser accepts the terms for one sale, on the version live now.
 * Once per sale per version; rendered here, never from client text.
 */
export async function acceptSaleTerms(
  sale: SaleRow,
  ctx: AcceptanceContext,
): Promise<{ accepted: true; templateVersion: number; acceptanceId: string }> {
  if (sale.status === 'CANCELLED' || sale.status === 'EXPIRED') {
    throw new ApiError(409, 'CONFLICT', 'This sale is no longer open and its terms cannot be accepted.');
  }
  const template = await currentTemplate('PACKAGE_SALE');
  const acceptance = await recordAcceptance({
    kind: 'PACKAGE_SALE',
    party: { advertiserId: sale.advertiserId },
    anchor: { packageSaleId: sale.id },
    ctx,
    renderedDocument: renderPackageTerms(template.body, sale),
  });
  return { accepted: true, templateVersion: acceptance.templateVersion, acceptanceId: acceptance.id };
}

/** Where the sale stands on its terms — carried on every sale read. */
export function saleTermsStanding(saleId: string): Promise<AgreementStanding> {
  return transactionAcceptance('PACKAGE_SALE', { packageSaleId: saleId });
}

/**
 * Payment needs the terms, on the version live now. Asked by both doors —
 * the advertiser paying from their wallet and ops recording money that
 * arrived outside — before anything moves, with the code the app routes on.
 */
export async function assertSaleTermsAccepted(saleId: string): Promise<AgreementStanding> {
  const standing = await saleTermsStanding(saleId);
  if (!standing.current) {
    throw new ApiError(
      403,
      'AGREEMENT_REQUIRED',
      standing.accepted
        ? 'The package terms have changed since they were accepted. Accept the current version before paying.'
        : 'Accept the package terms before paying.',
      { agreements: [standing] },
    );
  }
  return standing;
}

/* ------------------------------------------------------------------ */
/* Pricing                                                             */
/* ------------------------------------------------------------------ */

/**
 * The shipped annual discount — the SAVE 20% badge on the cycle toggle.
 * Since Lot J2 the live number is `settings.subscriptions.advertiser
 * .annualDiscountPct`; this is what that setting defaults to, kept for the
 * tests that pin the badge.
 */
export const ANNUAL_DISCOUNT_PCT = 20;
export const ANNUAL_MONTHS = 12;

const advertiserPolicy = (): Promise<SubscriptionPolicy> => getSubscriptionPolicy('advertiser');

/** Lot J2: the live rates — GST from revenue's tax row, the discount from the advertiser policy. */
async function saleRates(policy: SubscriptionPolicy): Promise<PricingRates> {
  const tax = await taxSettings();
  return { gstPct: fractionToPercent(tax.mediaGstPct), annualDiscountPct: policy.annualDiscountPct };
}

export type PricedSale = {
  cycle: 'MONTHLY' | 'ANNUAL';
  months: number;
  pricePerMonth: Money;
  addOnsPerMonth: Money;
  /** Plan plus add-ons, per month — the figure on the dark summary bar. */
  perMonth: Money;
  subtotal: Money;
  discountPct: Money;
  discountAmount: Money;
  gstPct: Money;
  gstAmount: Money;
  total: Money;
  lines: { kind: 'PLAN' | 'ADDON'; code: string; label: string; pricePerMonth: Money; months: number; amount: Money }[];
};

/**
 * What a plan and a set of add-ons costs.
 *
 * Pure, so the review screen and the sale itself work from one implementation
 * and cannot disagree about a total the advertiser is about to be charged.
 * Lot J2: the rates come in — GST from revenue's tax row, the annual
 * discount from the policy — so a test that pins the badge passes them.
 */
export function priceSale(input: {
  plan: { tier: string; name: string; pricePerMonth: Money };
  addOns: { code: string; name: string; pricePerMonth: Money }[];
  cycle: 'MONTHLY' | 'ANNUAL';
  rates: PricingRates;
}): PricedSale {
  const months = input.cycle === 'ANNUAL' ? ANNUAL_MONTHS : 1;
  const planPrice = new Decimal(input.plan.pricePerMonth);
  const addOnsPerMonth = input.addOns.reduce(
    (sum, addOn) => sum.plus(new Decimal(addOn.pricePerMonth)),
    new Decimal(0)
  );

  const perMonth = planPrice.plus(addOnsPerMonth);
  const subtotal = perMonth.times(months);
  const discountPct = input.cycle === 'ANNUAL' ? new Decimal(input.rates.annualDiscountPct) : new Decimal(0);
  const discountAmount = subtotal.times(discountPct).dividedBy(100);
  const taxable = subtotal.minus(discountAmount);
  const gstPct = new Decimal(input.rates.gstPct);
  const gstAmount = taxable.times(gstPct).dividedBy(100);

  const lines: PricedSale['lines'] = [
    {
      kind: 'PLAN',
      code: input.plan.tier,
      label: `${input.plan.name} plan`,
      pricePerMonth: money(planPrice),
      months,
      amount: money(planPrice.times(months)),
    },
    ...input.addOns.map((addOn) => ({
      kind: 'ADDON' as const,
      code: addOn.code,
      label: addOn.name,
      pricePerMonth: money(addOn.pricePerMonth),
      months,
      amount: money(new Decimal(addOn.pricePerMonth).times(months)),
    })),
  ];

  return {
    cycle: input.cycle,
    months,
    pricePerMonth: money(planPrice),
    addOnsPerMonth: money(addOnsPerMonth),
    perMonth: money(perMonth),
    subtotal: money(subtotal),
    discountPct: money(discountPct),
    discountAmount: money(discountAmount),
    gstPct: money(gstPct),
    gstAmount: money(gstAmount),
    total: money(taxable.plus(gstAmount)),
    lines,
  };
}

/**
 * Prices a tier and add-on codes against the live catalogue. Lot J2: the
 * policy first — a cycle it does not offer is refused 400 naming the ones
 * it does — then the rates (GST from revenue's tax row), and the policy
 * comes back beside the money so the phone prints rules it did not compute.
 */
export type QuotedTerm = {
  rule: SaleTerm['rule'];
  startsAt: Date;
  endsAt: Date;
  replaces: SaleTerm['replaces'];
  /** The credit the switch would post, or null. */
  prorationAmount: Money | null;
};

export async function quote(input: {
  tier: string;
  addOnCodes: string[];
  cycle: 'MONTHLY' | 'ANNUAL';
  /** Lot K (B2): whose term the rule is asked for — from the session, or the advertiser an agent names. Null answers no term. */
  advertiserId?: string | null | undefined;
  now?: Date | undefined;
}): Promise<{ priced: PricedSale; plan: PackageRow; addOns: { code: string; name: string; pricePerMonth: Money }[]; policy: PolicyView; term: QuotedTerm | null }> {
  const policy = await advertiserPolicy();
  assertCycleOffered(input.cycle, policy);
  await ensureCatalogue();
  const plan = await repository.findPackageByTier(input.tier as never);
  if (!plan || !plan.isActive) {
    throw new ApiError(404, 'NOT_FOUND', 'That package is not on sale.');
  }

  const found = await repository.findAddOnsByCode(input.addOnCodes);
  const missing = input.addOnCodes.filter((code) => !found.some((addOn) => addOn.code === code));
  if (missing.length > 0) {
    throw new ApiError(404, 'NOT_FOUND', `Unknown add-on: ${missing.join(', ')}`);
  }

  const addOns = found.map((addOn) => ({
    code: addOn.code,
    name: addOn.name,
    pricePerMonth: money(addOn.pricePerMonth),
  }));

  const priced = priceSale({
    plan: { tier: plan.tier, name: plan.name, pricePerMonth: money(plan.pricePerMonth) },
    addOns,
    cycle: input.cycle,
    rates: await saleRates(policy),
  });
  // Lot K (B2): the term rule the activation would apply, so no phone predicts it.
  const term = input.advertiserId
    ? await resolveSaleTerm({ advertiserId: input.advertiserId, tier: plan.tier, months: priced.months, packageName: plan.name }, input.now ?? new Date(), policy)
    : null;
  return {
    priced,
    plan,
    addOns,
    policy: policyView(policy, plan.tier),
    term: term ? { rule: term.rule, startsAt: term.startsAt, endsAt: term.endsAt, replaces: term.replaces, prorationAmount: term.credit?.amount ?? null } : null,
  };
}

/** Lot J2 (7): the wallet rail, when the policy has closed it — asked by `POST /sales/:id/pay` before the wallet. */
export async function assertWalletPaymentOffered(): Promise<void> {
  const policy = await advertiserPolicy();
  if (policy.payment.walletAllowed) return;
  throw new ApiError(403, 'PAYMENT_METHOD_NOT_OFFERED', 'Paying from your ADX wallet is not offered for packages. Pay through a gateway instead.', {
    method: 'WALLET',
    gatewaysAllowed: policy.payment.gatewaysAllowed,
  });
}

/* ------------------------------------------------------------------ */
/* References and tokens                                               */
/* ------------------------------------------------------------------ */

/** PKG-2026-482913, quoted on the link and the receipt. */
async function nextReference(now: Date): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const reference = `PKG-${now.getFullYear()}-${randomInt(100_000, 999_999)}`;
    if (!(await repository.referenceExists(reference))) return reference;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a package reference');
}

/**
 * The token in the payment link.
 *
 * 32 bytes of URL-safe randomness rather than the sale id: the link goes out
 * over SMS and email, and an id that appears in an API path is a thing somebody
 * can guess their way along. Opening the link only reveals what the advertiser
 * is being asked to pay; paying still needs their own session.
 */
async function nextToken(): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const token = randomBytes(24).toString('base64url');
    if (!(await repository.tokenExists(token))) return token;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a payment token');
}

export const paymentUrl = (token: string): string => {
  const base = env.BASE_URL ?? `http://localhost:${env.PORT}`;
  return `${base.replace(/\/$/, '')}/p/${token}`;
};

/* ------------------------------------------------------------------ */
/* The sale                                                            */
/* ------------------------------------------------------------------ */

export type SaleActor = {
  userId: string;
  isAdmin: boolean;
  agentId: string | null;
  advertiserId: string | null;
};

/** Whether this actor may see or act on this sale. */
export function assertMayAct(sale: { advertiserId: string; agentId: string | null }, actor: SaleActor): void {
  if (actor.isAdmin) return;
  if (actor.advertiserId && sale.advertiserId === actor.advertiserId) return;
  if (actor.agentId && sale.agentId === actor.agentId) return;
  throw new ApiError(403, 'FORBIDDEN', 'This sale belongs to someone else.');
}

/**
 * Whether this sale can still take money.
 *
 * Asked before the wallet is touched rather than after. `markPaid` refuses a
 * cancelled or expired sale too, but it runs in a second transaction — so a
 * status check that lives only there takes the money first and refuses second,
 * leaving the advertiser short for a plan that never activated.
 */
export function assertPayable(sale: { status: SaleRow['status'] }): void {
  if (sale.status === 'CANCELLED') {
    throw new ApiError(409, 'CONFLICT', 'This sale was cancelled and cannot be paid.');
  }
  if (sale.status === 'EXPIRED') {
    throw new ApiError(409, 'CONFLICT', 'This plan has run to the end of its term. Renewing it is a new sale.');
  }
  if (sale.status !== 'PENDING_PAYMENT') {
    throw new ApiError(409, 'CONFLICT', 'This sale is not waiting for payment.');
  }
}

/**
 * How many times one sale's link may go out, the first send included.
 *
 * Every send is an SMS to a real handset and an email to a real inbox, and the
 * endpoint that fires them is reachable by anyone who may read the sale. The
 * counter on the row was telemetry; this makes it a ceiling.
 */
export const MAX_PAYMENT_LINK_SENDS = 6;

/** Add-on codes, in a form two sales can be compared by. */
const addOnFingerprint = (codes: string[]): string => [...codes].sort().join(',');

/**
 * Creates the sale and sends the payment link.
 *
 * One call rather than a draft-then-send pair: the wizard's first two screens
 * are local choices with nothing to persist, and the third *is* the send. A
 * draft row per abandoned wizard would be a table of sales that never happened.
 */
export async function sellPackage(
  input: {
    advertiserId: string;
    tier: string;
    addOnCodes: string[];
    cycle: 'MONTHLY' | 'ANNUAL';
    /** Lot B (Q1): the field visit this sale is being made on. */
    visitId?: string | null;
  },
  actor: SaleActor,
  now = new Date()
): Promise<SaleRow> {
  // The visit has to be the seller's own, in progress or completed today —
  // the visits module decides, before anything is priced or written.
  if (input.visitId) await assertVisitOutcome(input.visitId, actor.agentId, now);

  const { priced, plan } = await quote(input);

  /*
   * One payable link per advertiser at a time.
   *
   * The third screen sends an SMS and then waits, so the agent's natural move
   * on a timeout or a dropped signal is to press Sell again — and without this
   * that produces a second sale, a second token and a second link, both live
   * and both payable. Identical composition is treated as the retry it almost
   * always is and resends the existing link; a different plan is a deliberate
   * second sale and says so, because cancelling the first one is a decision
   * that belongs to the agent rather than to a retry.
   */
  const open = await repository.listSales({
    advertiserId: input.advertiserId,
    status: ['PENDING_PAYMENT'],
    limit: 5,
  });
  const wanted = addOnFingerprint(input.addOnCodes);
  const twin = open.find(
    (candidate) =>
      candidate.tier === plan.tier &&
      candidate.cycle === input.cycle &&
      addOnFingerprint(
        candidate.lines.filter((line) => line.kind === 'ADDON').map((line) => line.code)
      ) === wanted
  );
  if (twin) return sendPaymentLink(twin.id, now);
  if (open.length > 0) {
    throw new ApiError(
      409,
      'CONFLICT',
      `${open[0]!.advertiser.companyName ?? open[0]!.advertiser.name} already has an unpaid ${open[0]!.packageName} plan (${open[0]!.reference}). Cancel it before selling a different one.`
    );
  }

  const sale = await repository.createSale({
    reference: await nextReference(now),
    advertiserId: input.advertiserId,
    agentId: actor.agentId,
    visitId: input.visitId ?? null,
    createdByUserId: actor.userId,
    packageId: plan.id,
    tier: plan.tier,
    packageName: plan.name,
    pricePerMonth: new Decimal(priced.pricePerMonth),
    cycle: input.cycle,
    months: priced.months,
    addOnsPerMonth: new Decimal(priced.addOnsPerMonth),
    subtotal: new Decimal(priced.subtotal),
    discountPct: new Decimal(priced.discountPct),
    discountAmount: new Decimal(priced.discountAmount),
    gstPct: new Decimal(priced.gstPct),
    gstAmount: new Decimal(priced.gstAmount),
    total: new Decimal(priced.total),
    paymentToken: await nextToken(),
    lines: priced.lines.map((line) => ({
      kind: line.kind,
      code: line.code,
      label: line.label,
      pricePerMonth: new Decimal(line.pricePerMonth),
      months: line.months,
      amount: new Decimal(line.amount),
    })),
  });

  return sendPaymentLink(sale.id, now);
}

/**
 * Sends — or resends — the payment link.
 *
 * Email and SMS both fire and neither can fail the call: a link that did not
 * send is a resend away, and losing the sale record because an SMTP host was
 * briefly down would be worse. WhatsApp is on the frame and not wired; the
 * response says which channels actually went, so the agent is not told a
 * message was sent that was not.
 */
export async function sendPaymentLink(saleId: string, now = new Date()): Promise<SaleRow> {
  const sale = await repository.findSale(saleId);
  if (!sale) throw new ApiError(404, 'NOT_FOUND', 'Sale not found');
  if (sale.status === 'ACTIVE') {
    throw new ApiError(409, 'CONFLICT', 'This package is already paid for and active.');
  }
  if (sale.status === 'CANCELLED') {
    throw new ApiError(409, 'CONFLICT', 'This sale was cancelled.');
  }
  if (sale.status === 'EXPIRED') {
    throw new ApiError(
      409,
      'CONFLICT',
      'This plan has run to the end of its term. Renewing it is a new sale.'
    );
  }
  if (sale.paymentLinkSends >= MAX_PAYMENT_LINK_SENDS) {
    throw new ApiError(
      429,
      'TOO_MANY_REQUESTS',
      `This link has been sent ${sale.paymentLinkSends} times. Call the advertiser rather than sending it again.`
    );
  }

  const url = paymentUrl(sale.paymentToken);
  const amount = money(sale.total);
  const name = sale.advertiser.companyName ?? sale.advertiser.name;

  // Lot E (Q87/Q147): the `package-link` template through the dispatcher —
  // email and SMS to the advertiser's own contact details (they may have no
  // login yet), queued with the variables and sent by the job, so a mail host
  // being down costs a minute rather than the message.
  void notify(
    'PACKAGE_LINK',
    null,
    { name, packageName: sale.packageName, amount, url, reference: sale.reference },
    { type: 'BOOKING', recipient: { email: sale.advertiser.email, mobile: sale.advertiser.mobile }, immediate: true },
  ).catch((err: unknown) => logger.warn('Package link dispatch failed', { saleId, reason: String(err) }));

  return repository.updateSale(sale.id, {
    status: 'PENDING_PAYMENT',
    paymentLinkSentAt: now,
    paymentLinkSends: sale.paymentLinkSends + 1,
  });
}

/** The channels a link actually goes out on, for the screen that says so. */
export function sendChannels(sale: SaleRow): { email: boolean; sms: boolean; whatsapp: false } {
  return { email: Boolean(sale.advertiser.email), sms: true, whatsapp: false };
}

/* ------------------------------------------------------------------ */
/* Payment and activation                                              */
/* ------------------------------------------------------------------ */

const addMonths = (from: Date, months: number): Date => {
  const to = new Date(from);
  const day = to.getUTCDate();
  to.setUTCMonth(to.getUTCMonth() + months);
  // A 31st that lands in a short month rolls back rather than into the next one.
  if (to.getUTCDate() < day) to.setUTCDate(0);
  return to;
};

/** Lot J2: what the activation decided about the term — the twin of revenue's `Term`. */
export type SaleTerm = {
  rule: 'STARTS_NOW' | 'QUEUED_AFTER_CURRENT' | 'REPLACES_CURRENT';
  startsAt: Date;
  endsAt: Date;
  /** The different-tier sale that ends the moment this one is paid. */
  replaces: { id: string; tier: string; endsAt: Date | null } | null;
  /** REPLACE_NOW with `prorateOnChange`: the replaced term's unused days, as the wallet credit posted after activation. */
  credit: ({ saleId: string; packageName: string } & Proration) | null;
};

/** Lot K (B2): the ceiling on a replaced sale's credit — what it paid; nothing for a trial. */
const paidTotalOf = (sale: Pick<SaleRow, 'paidMethod' | 'total'>): Prisma.Decimal | null => (sale.paidMethod === 'TRIAL' ? null : sale.total);

/**
 * Lot J2 (3): when a paid sale's term starts, given what the advertiser
 * already runs:
 *
 *  - nothing running → now;
 *  - the same tier running → at its end, like a renewal (a same-tier
 *    purchase mid-term is a renewal, never a second overlapping term);
 *  - a different tier running → the policy decides: REPLACE_NOW starts now
 *    and the running one ends now — with its unused days credited to the
 *    wallet when `prorateOnChange` is on — and QUEUE_AFTER_TERM starts at
 *    the running term's end.
 *
 * The twin of revenue's `resolveTerm`, for the advertiser side.
 */
export async function resolveSaleTerm(sale: { id?: string | undefined; advertiserId: string; tier: string; months: number; packageName: string }, now: Date, policy?: SubscriptionPolicy): Promise<SaleTerm> {
  const running = await repository.findActiveSale(sale.advertiserId, now);
  if (!running || running.id === sale.id || !running.endsAt || !running.startsAt) {
    return { rule: 'STARTS_NOW', startsAt: now, endsAt: addMonths(now, sale.months), replaces: null, credit: null };
  }
  const rules = policy ?? (await advertiserPolicy());
  if (running.tier === sale.tier || rules.changePolicy === 'QUEUE_AFTER_TERM') {
    return { rule: 'QUEUED_AFTER_CURRENT', startsAt: running.endsAt, endsAt: addMonths(running.endsAt, sale.months), replaces: null, credit: null };
  }
  // Lot K (B2): capped at what the running sale paid, over its own term's days — a trial earns nothing.
  const proration = rules.prorateOnChange ? prorationAmount({ paidTotal: paidTotalOf(running), startsAt: running.startsAt, endsAt: running.endsAt }, now) : null;
  return {
    rule: 'REPLACES_CURRENT',
    startsAt: now,
    endsAt: addMonths(now, sale.months),
    replaces: { id: running.id, tier: running.tier, endsAt: running.endsAt },
    credit: proration ? { saleId: running.id, packageName: running.packageName, ...proration } : null,
  };
}

/**
 * Marks a sale paid and starts its term.
 *
 * Idempotent: a webhook or an admin pressing twice must not extend a term or
 * double a payment. The term runs from payment, and the next billing date is
 * the end of it. Lot J2: the term follows the advertiser policy's change
 * rule (`resolveSaleTerm`) — a replaced sale ends now, its unused days
 * credited when the policy says so — and the sweep's renewal hands the
 * term in (it starts when the old one ended, not at "now"), carrying the
 * auto-renew flag onto the new term.
 */
export async function markPaid(
  saleId: string,
  input: { method: 'WALLET' | 'OFFLINE' | 'GATEWAY'; reference?: string | null; term?: SaleTerm | undefined; autoRenew?: boolean | undefined },
  now = new Date()
): Promise<SaleRow> {
  const sale = await repository.findSale(saleId);
  if (!sale) throw new ApiError(404, 'NOT_FOUND', 'Sale not found');
  if (sale.status === 'ACTIVE') return sale;
  if (sale.status === 'CANCELLED') {
    throw new ApiError(409, 'CONFLICT', 'This sale was cancelled and cannot be paid.');
  }
  /*
   * An expired term cannot be revived. Allowing it would overwrite startsAt,
   * endsAt and paidAt in place, so the term the advertiser actually served
   * would be gone — and the schema says plainly that renewal is a new sale.
   */
  if (sale.status === 'EXPIRED') {
    throw new ApiError(
      409,
      'CONFLICT',
      'This plan has run to the end of its term. Renewing it is a new sale.'
    );
  }

  const term = input.term ?? (await resolveSaleTerm(sale, now));
  const activated = await repository.updateSale(sale.id, {
    status: 'ACTIVE',
    paidAt: now,
    paidMethod: input.method,
    paidReference: input.reference ?? null,
    startsAt: term.startsAt,
    endsAt: term.endsAt,
    nextBillingAt: term.endsAt,
    incentiveId: await commissionFor(sale, now),
    ...(input.autoRenew !== undefined ? { autoRenew: input.autoRenew } : {}),
  });

  // Lot J2 (3): REPLACE_NOW — the running different-tier term ends now,
  // EXPIRED at once so the expiry sweep does not later call it a lapse.
  if (term.replaces) {
    await repository.updateSale(term.replaces.id, { status: 'EXPIRED', endsAt: now, nextBillingAt: null });
  }
  if (term.credit) await postSaleProrationCredit(sale, term.credit, now);

  // Lot B (Q13): the tax invoice for the sale, PAID — through the port,
  // best-effort, after the activation it documents (see invoicing.port.ts).
  await packageInvoicing.issueForPackageSale(sale.id, sale.createdByUserId);

  void createNotification({
    userId: sale.createdByUserId,
    type: 'SYSTEM',
    title: 'Package activated',
    message:
      term.rule === 'QUEUED_AFTER_CURRENT'
        ? `${sale.packageName} is paid for on ${sale.advertiser.companyName ?? sale.advertiser.name} and starts on ${dateLabel(term.startsAt)}, when the current plan ends. Reference ${sale.reference}.`
        : `${sale.packageName} is live on ${sale.advertiser.companyName ?? sale.advertiser.name}. Reference ${sale.reference}.`,
    relatedId: sale.id,
  }).catch(() => {});

  return activated;
}

/** The advertiser wallet's label, as `advertisers` opens it. */
const advertiserWalletLabel = (advertiser: { name: string; companyName: string | null }) => `${advertiser.companyName ?? advertiser.name} · advertiser`;

/**
 * Lot J2 (3): the unused days of the replaced term come back as a wallet
 * CREDIT — an ADJUSTMENT line on the advertiser wallet against
 * `platform:revenue` (revenue given back), keyed on the sale so a retry
 * posts it once, with the reason on the line. Best-effort after the
 * activation it belongs to: a credit that failed to post is logged for
 * finance, never a reason to undo a plan that is already live.
 */
async function postSaleProrationCredit(sale: SaleRow, credit: NonNullable<SaleTerm['credit']>, now: Date): Promise<void> {
  try {
    const wallet = await ensureWallet({ kind: 'ADVERTISER', id: sale.advertiserId }, advertiserWalletLabel(sale.advertiser));
    await move({
      walletId: wallet.id,
      walletLabel: advertiserWalletLabel(sale.advertiser),
      amount: credit.amount,
      entryType: 'ADJUSTMENT',
      ledgerKind: 'ADJUSTMENT',
      idempotencyKey: `package-proration:${sale.id}`,
      counterLegs: [{ accountCode: 'platform:revenue', amount: money(new Decimal(credit.amount).negated()), note: `Unused days of ${credit.packageName}` }],
      reference: credit.saleId,
      note: `Unused days of ${credit.packageName}`,
      createdByUserId: null,
      occurredAt: now,
    });
  } catch (error) {
    logger.error('Package proration credit not posted', { saleId: sale.id, replaced: credit.saleId, amount: credit.amount, reason: String(error) });
  }
}

/* ------------------------------------------------------------------ */
/* Lot J2 (5): free trials                                             */
/* ------------------------------------------------------------------ */

/** The tiers this advertiser may still start a trial of, with the days — empty once they have ever held a term. */
export function trialTiersAvailable(policy: SubscriptionPolicy, everHeld: boolean, catalogue: readonly { tier: string; isActive: boolean }[]): Record<string, number> {
  if (everHeld) return {};
  const out: Record<string, number> = {};
  for (const plan of catalogue) {
    const days = policy.trialDays[plan.tier] ?? 0;
    if (plan.isActive && days > 0) out[plan.tier] = days;
  }
  return out;
}

export const TRIAL_TITLE = 'Your free trial has started';

/**
 * The advertiser themselves starts a free trial of a tier: a sale ACTIVE at
 * once with a zero total, `paidMethod` TRIAL, `endsAt = now + trialDays`,
 * no agent, no incentive, no invoice. Refused 409 when the tier offers no
 * trial, and when the advertiser has ever held a term — running or not —
 * because a trial is for a first plan and a second trial is a discount
 * nobody approved.
 *
 * Lot K (B2): the "never held a term" check is asked twice — once here,
 * for the plain refusal, and again inside the repository's transaction
 * under a per-advertiser advisory lock (`pg_advisory_xact_lock`, the way
 * `wallets.move` serialises a wallet), so two taps arriving together are
 * one trial and one 409, never two trials.
 */
export async function startPackageTrial(input: { advertiserId: string; userId: string; tier: string; now?: Date }): Promise<SaleRow> {
  const now = input.now ?? new Date();
  const policy = await advertiserPolicy();
  const days = policy.trialDays[input.tier] ?? 0;
  if (days <= 0) throw new ApiError(409, 'TRIAL_NOT_OFFERED', `The ${input.tier.charAt(0)}${input.tier.slice(1).toLowerCase()} plan does not offer a free trial.`);
  if (await repository.hasEverHeldSale(input.advertiserId)) throw trialAlreadyUsed();
  await ensureCatalogue();
  const plan = await repository.findPackageByTier(input.tier as never);
  if (!plan || !plan.isActive) throw new ApiError(404, 'NOT_FOUND', 'That package is not on sale.');

  const zero = new Decimal(0);
  const endsAt = new Date(now.getTime() + days * DAY_MS);
  const started = await repository.startTrial({
    advertiserId: input.advertiserId,
    now,
    startsAt: now,
    endsAt,
    sale: {
      reference: await nextReference(now),
      advertiserId: input.advertiserId,
      agentId: null,
      visitId: null,
      createdByUserId: input.userId,
      packageId: plan.id,
      tier: plan.tier,
      packageName: plan.name,
      pricePerMonth: new Decimal(plan.pricePerMonth),
      cycle: 'MONTHLY',
      // The term is `days`, not months; nothing was billed.
      months: 0,
      addOnsPerMonth: zero,
      subtotal: zero,
      discountPct: zero,
      discountAmount: zero,
      gstPct: zero,
      gstAmount: zero,
      total: zero,
      paymentToken: await nextToken(),
      lines: [{ kind: 'PLAN', code: plan.tier, label: `${plan.name} plan (free trial)`, pricePerMonth: new Decimal(plan.pricePerMonth), months: 0, amount: zero }],
    },
  });
  // The re-check under the lock: another start got there first.
  if (!started.started) throw trialAlreadyUsed();
  void createNotification({
    userId: input.userId,
    type: 'SYSTEM',
    title: TRIAL_TITLE,
    message: `Your free trial of ${plan.name} runs until ${dateLabel(endsAt)}. Buy the plan in the app before then to keep it.`,
    relatedId: started.sale.id,
  }).catch(() => {});
  return started.sale;
}

const trialAlreadyUsed = () => new ApiError(409, 'TRIAL_ALREADY_USED', 'A free trial is for a first plan; this account has held one before. Buy the plan instead.');

/* ------------------------------------------------------------------ */
/* Lot J2 (6): the advertiser's auto-renew switch                      */
/* ------------------------------------------------------------------ */

/** `PATCH /packages/active { autoRenew }`: the flag on the running sale; 409 while the policy does not offer it. */
export async function setActivePackageAutoRenew(advertiserId: string, autoRenew: boolean, now = new Date()): Promise<SaleRow> {
  const policy = await advertiserPolicy();
  if (autoRenew && !policy.autoRenew.allowed) {
    throw new ApiError(409, 'AUTO_RENEW_NOT_OFFERED', 'Auto-renew is not offered');
  }
  const running = await repository.findActiveSale(advertiserId, now);
  if (!running) throw new ApiError(404, 'NOT_FOUND', 'There is no running package to renew.');
  // Lot K (B2): a trial is not a term that renews — the plan is bought, not extended.
  if (autoRenew && running.paidMethod === 'TRIAL') throw new ApiError(409, 'AUTO_RENEW_NOT_OFFERED', 'A trial does not renew - buy the plan');
  if (running.autoRenew === autoRenew) return running;
  return repository.updateSale(running.id, { autoRenew });
}

/**
 * Lot B (Q13): the sale as `invoices` itemises it — the plan and add-on
 * lines, the annual discount and the GST as they were priced, never re-run
 * against the catalogue. `gstPct` is the sale's own percent (18), which the
 * invoice converts to the fraction its lines carry.
 */
export type PackageSaleInvoiceSnapshot = {
  id: string;
  reference: string;
  advertiserId: string;
  createdByUserId: string;
  status: SaleRow['status'];
  packageName: string;
  tier: string;
  cycle: 'MONTHLY' | 'ANNUAL';
  months: number;
  subtotal: Money;
  discountPct: Money;
  discountAmount: Money;
  /** A percent — "18.00" — as the sale stores it. */
  gstPct: Money;
  gstAmount: Money;
  total: Money;
  paidAt: Date | null;
  /** Lot J2: TRIAL is a term nobody paid for. */
  paidMethod: 'WALLET' | 'OFFLINE' | 'GATEWAY' | 'TRIAL' | null;
  paidReference: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  lines: { kind: string; code: string; label: string; pricePerMonth: Money; months: number; amount: Money }[];
};

export async function findSaleForInvoice(saleId: string): Promise<PackageSaleInvoiceSnapshot | null> {
  const sale = await repository.findSale(saleId);
  if (!sale) return null;
  return {
    id: sale.id,
    reference: sale.reference,
    advertiserId: sale.advertiserId,
    createdByUserId: sale.createdByUserId,
    status: sale.status,
    packageName: sale.packageName,
    tier: sale.tier,
    cycle: sale.cycle,
    months: sale.months,
    subtotal: money(sale.subtotal),
    discountPct: money(sale.discountPct),
    discountAmount: money(sale.discountAmount),
    gstPct: money(sale.gstPct),
    gstAmount: money(sale.gstAmount),
    total: money(sale.total),
    paidAt: sale.paidAt,
    paidMethod: sale.paidMethod,
    paidReference: sale.paidReference,
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
    lines: sale.lines.map((line) => ({
      kind: line.kind,
      code: line.code,
      label: line.label,
      pricePerMonth: money(line.pricePerMonth),
      months: line.months,
      amount: money(line.amount),
    })),
  };
}

export async function cancelSale(saleId: string, reason: string, now = new Date()): Promise<SaleRow> {
  const sale = await repository.findSale(saleId);
  if (!sale) throw new ApiError(404, 'NOT_FOUND', 'Sale not found');
  if (sale.status === 'ACTIVE') {
    throw new ApiError(
      409,
      'CONFLICT',
      'This package is live and has been paid for. A refund is a support decision, not a cancellation.'
    );
  }
  return repository.updateSale(sale.id, {
    status: 'CANCELLED',
    cancelledAt: now,
    cancellationReason: reason,
  });
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * The agent's commission on a paid sale (decision 16).
 *
 * PACKAGE_SOLD is priced in the rate table like every other incentive and
 * recorded here, at the selling agent's tier, landing PENDING_VERIFICATION
 * for finance to release. A sale nobody sold — an admin renewing from the
 * console — earns nobody anything. A sale whose tier has no rate is still
 * paid for; it just records no commission, and the card prints nothing.
 */
async function commissionFor(sale: SaleRow, now: Date): Promise<string | null> {
  if (!sale.agentId) return null;
  const tier = await repository.agentTier(sale.agentId);
  if (!tier) return null;
  try {
    const incentive = await recordIncentive(
      {
        agentId: sale.agentId,
        event: 'PACKAGE_SOLD',
        tier,
        advertiserId: sale.advertiserId,
        note: `Package sale ${sale.reference}: ${sale.packageName}`,
      },
      now
    );
    return incentive.id;
  } catch (error) {
    logger.warn('PACKAGE_SOLD not recorded', { saleId: sale.id, reason: String(error) });
    return null;
  }
}

/** "₹2,500 comm." per sale — the recorded incentive's amount, or null. Never zero. */
export async function commissionsFor(sales: SaleRow[]): Promise<Map<string, Money>> {
  const ids = sales.map((sale) => sale.incentiveId).filter((id): id is string => !!id);
  const amounts = await repository.commissionAmounts(ids);
  const out = new Map<string, Money>();
  for (const sale of sales) {
    const amount = sale.incentiveId ? amounts.get(sale.incentiveId) : undefined;
    if (amount) out.set(sale.id, money(amount));
  }
  return out;
}

/** The sale with no ownership question asked — for a guard that runs before one. */
export const findSale = (saleId: string): Promise<SaleRow | null> => repository.findSale(saleId);

export async function getSale(saleId: string, actor: SaleActor): Promise<SaleRow> {
  const sale = await repository.findSale(saleId);
  if (!sale) throw new ApiError(404, 'NOT_FOUND', 'Sale not found');
  assertMayAct(sale, actor);
  return sale;
}

export function listSales(actor: SaleActor, filter: { status?: string[]; limit?: number }) {
  return repository.listSales({
    ...(actor.isAdmin
      ? {}
      : actor.advertiserId
        ? { advertiserId: actor.advertiserId }
        : { agentId: actor.agentId ?? '__none__' }),
    ...(filter.status ? { status: filter.status as never } : {}),
    limit: Math.min(filter.limit ?? 50, 200),
  });
}

/**
 * The agent's package book as DR 06 draws it: a page, its total, and a count
 * per chip.
 *
 * `listSales` above stays an array — `sellPackage` folds over open sales to
 * catch a duplicate before creating one, and a page would make that check
 * depend on where the duplicate happened to fall.
 */
export async function listSalesPage(actor: SaleActor, query: ListSalesQuery) {
  const { items, total, counts } = await repository.listSalesPage({
    ...(actor.isAdmin
      ? {}
      : actor.advertiserId
        ? { advertiserId: actor.advertiserId }
        : { agentId: actor.agentId ?? '__none__' }),
    ...(query.shelf ? { shelf: query.shelf } : {}),
    ...(query.status ? { status: query.status as never } : {}),
    ...(query.q ? { q: query.q } : {}),
    sort: query.sort,
    page: query.page,
    pageSize: query.pageSize,
  });
  return toListPage(items, total, counts, query);
}

/**
 * What the payment link shows before anybody signs in.
 *
 * Deliberately thin: the plan, the amount and who it is for. Enough for the
 * advertiser to recognise it as theirs, and not enough to be worth guessing a
 * token for.
 */
export async function publicSaleView(token: string) {
  const sale = await repository.findSaleByToken(token);
  if (!sale) throw new ApiError(404, 'NOT_FOUND', 'This payment link is not valid.');

  return {
    reference: sale.reference,
    advertiserName: sale.advertiser.companyName ?? sale.advertiser.name,
    packageName: sale.packageName,
    cycle: sale.cycle,
    months: sale.months,
    subtotal: money(sale.subtotal),
    discountAmount: money(sale.discountAmount),
    gstAmount: money(sale.gstAmount),
    total: money(sale.total),
    status: sale.status,
    lines: sale.lines.map((line) => ({
      label: line.label,
      amount: money(line.amount),
    })),
    paidAt: sale.paidAt,
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
  };
}

/** The advertiser's live plan, and what it says it entitles them to. */
export async function activePackage(advertiserId: string, now = new Date()) {
  const sale = await repository.findActiveSale(advertiserId, now);
  if (!sale) return null;
  const plan = await repository.findPackage(sale.packageId);
  return activePackageView(sale, plan);
}

/**
 * Lot J2 (5/6): what `GET /packages/active` answers — the live plan (or
 * none) beside the trials the advertiser may still start, per tier with
 * the days, and the policy the phone prints. `saleId: null` when nothing
 * runs, so the phone reads one shape.
 */
export async function activePackageWithOptions(advertiserId: string, now = new Date()) {
  const [policy, active, everHeld] = await Promise.all([advertiserPolicy(), activePackage(advertiserId, now), repository.hasEverHeldSale(advertiserId)]);
  await ensureCatalogue();
  const catalogue = await repository.listPackages(false);
  // Lot K (B2): with nothing running, the term the policy's grace window still covers, if any.
  const lapsed = !active && policy.graceDays > 0 ? await repository.findLapsedSale(advertiserId, new Date(now.getTime() - policy.graceDays * DAY_MS), now) : null;
  const grace: PackageGrace | null = lapsed?.endsAt
    ? { tier: lapsed.tier, packageName: lapsed.packageName, endsAt: lapsed.endsAt, until: new Date(lapsed.endsAt.getTime() + policy.graceDays * DAY_MS) }
    : null;
  return {
    ...(active ?? { saleId: null }),
    /** Lot K (B2): the ended term still honoured under grace — null while one runs, or once the window has passed. */
    grace,
    trialAvailable: trialTiersAvailable(policy, everHeld, catalogue),
    policy: policyView(policy, active?.tier ?? catalogue[0]?.tier ?? 'STARTER'),
  };
}

/** Lot K (B2): what the phone prints while an ended term is still honoured. */
export type PackageGrace = { tier: string; packageName: string; endsAt: Date; until: Date };

const DAY_MS = 24 * 60 * 60 * 1000;

export type EntitledPackage = ReturnType<typeof activePackageView> & {
  /** True when the term has ended and the policy's grace window still covers it. */
  inGrace: boolean;
  /** `endsAt + graceDays`; null for a term with no end. */
  graceEndsAt: Date | null;
};

const entitledView = (sale: SaleRow, plan: PackageRow | null, at: Date, graceDays: number): EntitledPackage => {
  const running = sale.startsAt !== null && sale.startsAt <= at && (sale.endsAt === null || sale.endsAt >= at);
  return {
    ...activePackageView(sale, plan),
    inGrace: !running,
    graceEndsAt: sale.endsAt ? new Date(sale.endsAt.getTime() + graceDays * DAY_MS) : null,
  };
};

/**
 * Lot J2 (4): the package an advertiser is entitled under at `at` — the
 * running one, or, with `graceDays` on the policy, the one that ended
 * within that many days, marked `inGrace`. What `support`'s live-chat door
 * reads; the entitlements are copy and live chat, never money.
 */
export async function entitledPackageForAdvertiser(advertiserId: string, at: Date = new Date()): Promise<EntitledPackage | null> {
  const { graceDays } = await advertiserPolicy();
  const running = await repository.findActiveSale(advertiserId, at);
  const sale = running ?? (graceDays > 0 ? await repository.findLapsedSale(advertiserId, new Date(at.getTime() - graceDays * DAY_MS), at) : null);
  if (!sale) return null;
  const plan = await repository.findPackage(sale.packageId);
  return entitledView(sale, plan, at, graceDays);
}

/** The same fact for a set — the running sales, then the lapsed ones for whoever has nothing running, then their plans. */
export async function entitledPackagesForAdvertisers(advertiserIds: readonly string[], at: Date = new Date()): Promise<Map<string, EntitledPackage>> {
  const out = new Map<string, EntitledPackage>();
  const unique = [...new Set(advertiserIds)];
  if (unique.length === 0) return out;
  const { graceDays } = await advertiserPolicy();
  const chosen = new Map<string, SaleRow>();
  for (const sale of await repository.findActiveSales(unique, at)) if (!chosen.has(sale.advertiserId)) chosen.set(sale.advertiserId, sale);
  const missing = unique.filter((id) => !chosen.has(id));
  if (graceDays > 0 && missing.length > 0) {
    for (const sale of await repository.findLapsedSales(missing, new Date(at.getTime() - graceDays * DAY_MS), at)) {
      if (!chosen.has(sale.advertiserId)) chosen.set(sale.advertiserId, sale);
    }
  }
  if (chosen.size === 0) return out;
  const plans = await repository.findPackagesByIds([...new Set([...chosen.values()].map((sale) => sale.packageId))]);
  const planOf = new Map(plans.map((plan) => [plan.id, plan]));
  for (const [advertiserId, sale] of chosen) out.set(advertiserId, entitledView(sale, planOf.get(sale.packageId) ?? null, at, graceDays));
  return out;
}

/**
 * The same read for a set of advertisers — Lot I (I4-B), what `support`'s
 * inbox asks so a page of chats costs two queries (the sales, then their
 * plans), not two per row. An advertiser with nothing live is absent.
 */
export async function activePackagesForAdvertisers(advertiserIds: readonly string[], now = new Date()) {
  const out = new Map<string, ReturnType<typeof activePackageView>>();
  const unique = [...new Set(advertiserIds)];
  if (unique.length === 0) return out;
  const sales = await repository.findActiveSales(unique, now);
  const newest = new Map<string, SaleRow>();
  for (const sale of sales) if (!newest.has(sale.advertiserId)) newest.set(sale.advertiserId, sale);
  const plans = await repository.findPackagesByIds([...new Set([...newest.values()].map((sale) => sale.packageId))]);
  const planOf = new Map(plans.map((plan) => [plan.id, plan]));
  for (const [advertiserId, sale] of newest) out.set(advertiserId, activePackageView(sale, planOf.get(sale.packageId) ?? null));
  return out;
}

/**
 * Which keys of the entitlements JSON a rule somewhere actually reads.
 *
 * `liveChat` is read by `support.live-chat` (`support/live-chat.entitlement.ts`,
 * `planAllowsLiveChat`): `liveChat: false` on a plan keeps its advertisers
 * off live chat, anything else lets them on. Every other key is copy —
 * named on the plan card, returned here, read by no rule — and the screens
 * that show them say so rather than implying a gate.
 */
export const ENFORCED_ENTITLEMENT_KEYS = ['liveChat'] as const;

function activePackageView(sale: SaleRow, plan: PackageRow | null) {
  return {
    saleId: sale.id,
    reference: sale.reference,
    tier: sale.tier,
    packageName: sale.packageName,
    cycle: sale.cycle,
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
    nextBillingAt: sale.nextBillingAt,
    addOns: sale.lines.filter((line) => line.kind === 'ADDON').map((line) => line.label),
    /** Lot J2: TRIAL for a free trial; the advertiser's own auto-renew switch. */
    paidMethod: sale.paidMethod,
    autoRenew: sale.autoRenew,
    entitlements: plan?.entitlements ?? {},
    /*
     * `enforced` stays the phones' boolean — "is this JSON a gate as a
     * whole?" — and stays false, because most of it is copy. `enforcedKeys`
     * names the exception: the keys a rule reads, today `liveChat` through
     * `support.live-chat`.
     */
    enforced: false,
    enforcedKeys: [...ENFORCED_ENTITLEMENT_KEYS] as string[],
  };
}

/**
 * Expires terms that have run out.
 *
 * Run by the scheduler every five minutes. Lot J2: a sale with auto-renew
 * on (theirs and the policy's) is left to the daily renewal sweep, which
 * buys the next term from the wallet; the expiry notice is for the rest.
 */
export async function runPackageExpiry(now = new Date()): Promise<{ expired: number }> {
  const due = await repository.findExpiredSales(now);
  const { autoRenew } = await advertiserPolicy();
  for (const sale of due) {
    await repository.updateSale(sale.id, { status: 'EXPIRED' });
    if (autoRenew.allowed && sale.autoRenew) continue;
    void createNotification({
      userId: sale.createdByUserId,
      type: 'SYSTEM',
      title: 'Package expired',
      message: `${sale.packageName} on ${sale.advertiser.companyName ?? sale.advertiser.name} has run to the end of its term. Renewing is a new sale.`,
      relatedId: sale.id,
    }).catch(() => {});
  }
  return { expired: due.length };
}

/* ------------------------------------------------------------------ */
/* Lot J2 (6): the daily renewal sweep                                 */
/* ------------------------------------------------------------------ */

export const EXPIRING_TITLE = 'Your package ends soon';
export const RENEWED_TITLE = 'Your package has renewed';
export const RENEWAL_FAILED_TITLE = 'Your package could not renew';

export type RenewalSummary = { expiringNotified: number; renewed: number; renewalsFailed: number };

/** 14 Sept 2026, as the advertiser reads it in India. */
export function dateLabel(at: Date): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}

/**
 * Two duties, once a day (`jobs/package-renewal.job.ts`), every window from
 * the advertiser policy:
 *
 *  1. every sale ending within `reminderLeadDays` gets an in-app reminder
 *     once (the marker is the row it writes); with auto-renew on — theirs
 *     and the policy's — the line says what the wallet will be charged and
 *     when, otherwise that renewing is a new sale;
 *  2. every sale that lapsed inside that window with auto-renew on, while
 *     the policy allows it, is renewed: the next sale on the same tier,
 *     add-ons and cycle, priced at today's catalogue, starting when the old
 *     one ended, paid from the wallet through `advertisers.payForPackage`
 *     (keyed on the sale, so a retry is one debit) and the same `markPaid`,
 *     `SUBSCRIPTION_RENEWED` sent; with the wallet short — or any other gate
 *     shut — `SUBSCRIPTION_RENEWAL_FAILED` once with the shortfall, the flag
 *     left on and the term lapsing into grace like any other. The queued
 *     sale's existence is what makes it never charge twice; with the
 *     policy's switch off nobody is charged.
 *
 * The package terms (Lot D) are not asked again on a renewal: the
 * advertiser accepted them on the sale they switched auto-renew on, and a
 * renewal is that sale's next term, not a new choice.
 */
export async function runPackageRenewals(now = new Date()): Promise<RenewalSummary> {
  const policy = await advertiserPolicy();
  const rates = await saleRates(policy);
  const lead = policy.reminderLeadDays;
  const autoRenewOn = policy.autoRenew.allowed;
  let expiringNotified = 0;
  let renewed = 0;
  let renewalsFailed = 0;

  for (const sale of await repository.findEndingBetween(now, new Date(now.getTime() + lead * DAY_MS))) {
    const userId = sale.advertiser.userId;
    if (!userId || !sale.endsAt || sale.status !== 'ACTIVE') continue;
    if (await repository.noticeSent(userId, sale.id, EXPIRING_TITLE)) continue;
    // Lot K (B2): a trial never renews, whatever its flag says.
    const trial = sale.paidMethod === 'TRIAL';
    const willRenew = autoRenewOn && sale.autoRenew && !trial;
    const total = willRenew ? (await renewalQuote(sale, policy, rates)).priced.total : null;
    await createNotification({
      userId,
      type: 'SYSTEM',
      title: EXPIRING_TITLE,
      message: willRenew && total
        ? `Your ${sale.packageName} plan renews from your wallet on ${dateLabel(sale.endsAt)} for ₹${total}.`
        : trial
          ? `Your free trial of ${sale.packageName} ends on ${dateLabel(sale.endsAt)}. A trial does not renew — buy the plan in the app before then to keep it.`
          : `Your ${sale.packageName} plan ends on ${dateLabel(sale.endsAt)}. Renewing is a new sale — buy it in the app before then.`,
      relatedId: sale.id,
    });
    expiringNotified += 1;
  }

  if (autoRenewOn) {
    for (const sale of await repository.findEndingBetween(new Date(now.getTime() - lead * DAY_MS), now)) {
      // Lot K (B2): a TRIAL sale never renews — the plan is bought, not extended.
      if (!sale.autoRenew || !sale.endsAt || sale.paidMethod === 'TRIAL') continue;
      if (await repository.hasSuccessorSale(sale.advertiserId, sale.endsAt, sale.id)) continue;
      const outcome = await renewSale(sale, policy, rates, now);
      if (outcome === 'RENEWED') renewed += 1;
      else if (outcome === 'FAILED') renewalsFailed += 1;
    }
  }
  return { expiringNotified, renewed, renewalsFailed };
}

/** The next term as the catalogue prices it today: the same tier and add-ons, the cycle while the policy still offers it. */
async function renewalQuote(sale: SaleRow, policy: SubscriptionPolicy, rates: PricingRates) {
  await ensureCatalogue();
  const plan = await repository.findPackageByTier(sale.tier);
  const codes = sale.lines.filter((line) => line.kind === 'ADDON').map((line) => line.code);
  const found = await repository.findAddOnsByCode(codes);
  const addOns = found.map((addOn) => ({ code: addOn.code, name: addOn.name, pricePerMonth: money(addOn.pricePerMonth) }));
  const cycle = policy.cyclesOffered.includes(sale.cycle) ? sale.cycle : policy.cyclesOffered[0]!;
  const priced = priceSale({
    plan: { tier: sale.tier, name: plan?.name ?? sale.packageName, pricePerMonth: money(plan?.pricePerMonth ?? sale.pricePerMonth) },
    addOns,
    cycle,
    rates,
  });
  return { plan, priced };
}

async function renewSale(old: SaleRow, policy: SubscriptionPolicy, rates: PricingRates, now: Date): Promise<'RENEWED' | 'FAILED' | 'SKIPPED'> {
  const userId = old.advertiser.userId;
  const endsAt = old.endsAt!;
  const { plan, priced } = await renewalQuote(old, policy, rates);

  const fail = async (reason: string, shortfall: Money): Promise<'FAILED'> => {
    if (userId && !(await repository.noticeSent(userId, old.id, RENEWAL_FAILED_TITLE))) {
      await notify(
        'SUBSCRIPTION_RENEWAL_FAILED',
        userId,
        { planName: old.packageName, total: priced.total, shortfall, reason, endedAt: dateLabel(endsAt) },
        {
          inApp: {
            type: 'SYSTEM',
            title: RENEWAL_FAILED_TITLE,
            message: `Your ${old.packageName} plan could not renew from your wallet: ${reason} Top up and buy the plan in the app to keep it.`,
            relatedId: old.id,
          },
        },
        now,
      );
    }
    return 'FAILED';
  };

  if (!plan || !plan.isActive) return fail('the plan is no longer on sale.', priced.total);

  let sale = await repository.findSaleStartingAt(old.advertiserId, old.tier, endsAt);
  if (sale?.status === 'ACTIVE') return 'SKIPPED';
  if (!sale) {
    const created = await repository.createSale({
      reference: await nextReference(now),
      advertiserId: old.advertiserId,
      agentId: null,
      visitId: null,
      createdByUserId: userId ?? old.createdByUserId,
      packageId: plan.id,
      tier: plan.tier,
      packageName: plan.name,
      pricePerMonth: new Decimal(priced.pricePerMonth),
      cycle: priced.cycle,
      months: priced.months,
      addOnsPerMonth: new Decimal(priced.addOnsPerMonth),
      subtotal: new Decimal(priced.subtotal),
      discountPct: new Decimal(priced.discountPct),
      discountAmount: new Decimal(priced.discountAmount),
      gstPct: new Decimal(priced.gstPct),
      gstAmount: new Decimal(priced.gstAmount),
      total: new Decimal(priced.total),
      paymentToken: await nextToken(),
      lines: priced.lines.map((line) => ({
        kind: line.kind,
        code: line.code,
        label: line.label,
        pricePerMonth: new Decimal(line.pricePerMonth),
        months: line.months,
        amount: new Decimal(line.amount),
      })),
    });
    // The queued renewal, waiting for the wallet — dated at the old term's end so the next run finds it.
    sale = await repository.updateSale(created.id, { status: 'PENDING_PAYMENT', startsAt: endsAt });
  }

  const total = money(sale.total);
  const eligibility = await bookingEligibility(old.advertiserId, total);
  if (!eligibility.eligible) {
    const spendable = new Decimal(eligibility.wallet?.spendable ?? 0);
    const shortfall = money(Decimal.max(new Decimal(total).minus(spendable), new Decimal(0)));
    const reason = eligibility.blockedBy.includes('FUNDS') && eligibility.blockedBy.length === 1
      ? `your wallet holds ₹${money(spendable)} and the plan costs ₹${total}.`
      : `the account cannot pay right now (${eligibility.blockedBy.join(', ').toLowerCase()}).`;
    return fail(reason, shortfall);
  }
  try {
    await payForPackage(old.advertiserId, sale.id, total, `${sale.packageName} plan — ${sale.reference} (renewal)`);
  } catch (error) {
    return fail(error instanceof Error ? `${error.message}.` : 'the wallet refused the debit.', total);
  }
  const term: SaleTerm = { rule: 'QUEUED_AFTER_CURRENT', startsAt: endsAt, endsAt: addMonths(endsAt, sale.months), replaces: null, credit: null };
  const paid = await markPaid(sale.id, { method: 'WALLET', reference: sale.id, term, autoRenew: true }, now);
  if (userId) {
    await notify(
      'SUBSCRIPTION_RENEWED',
      userId,
      { planName: paid.packageName, startsAt: dateLabel(term.startsAt), endsAt: dateLabel(term.endsAt), total, reference: paid.reference },
      {
        inApp: {
          type: 'SYSTEM',
          title: RENEWED_TITLE,
          message: `Your ${paid.packageName} plan renewed from your wallet for ₹${total} and runs until ${dateLabel(term.endsAt)}. Reference ${paid.reference}.`,
          relatedId: paid.id,
        },
      },
      now,
    );
  }
  return 'RENEWED';
}
