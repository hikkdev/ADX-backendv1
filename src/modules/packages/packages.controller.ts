import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { money, type Money } from '../../shared/money';
import { assertNotSuspended, getAdvertiserForUser, payForPackage } from '../advertisers';
import { findWorkingAgentProfile } from '../agents';
import {
  autoRenewSchema,
  cancelSchema,
  createAddOnSchema,
  listSalesQuerySchema,
  markPaidSchema,
  quoteSchema,
  sellSchema,
  tierParamSchema,
  trialSchema,
  updateAddOnSchema,
  updatePlanSchema,
} from './packages.schema';
import {
  acceptSaleTerms,
  activePackageWithOptions,
  assertMayAcceptTerms,
  assertMayAct,
  assertPayable,
  assertSaleTermsAccepted,
  assertWalletPaymentOffered,
  cancelSale,
  commissionsFor,
  createAddOn,
  findSale,
  getSale,
  listCatalogue,
  listSalesPage,
  markPaid,
  paymentUrl,
  publicSaleView,
  quote,
  saleTermsStanding,
  sellPackage,
  sendChannels,
  sendPaymentLink,
  setActivePackageAutoRenew,
  startPackageTrial,
  updateAddOn,
  updatePlan,
  type SaleActor,
} from './packages.service';
import { prismaPackagesRepository as repository } from './prisma-packages.repository';
import type { SaleRow } from './packages.repository';

function parse<T>(schema: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

/** Neither an agent nor an advertiser is trusted to say which they are. */
async function resolveActor(req: Request): Promise<SaleActor> {
  const userId = req.user!.sub;
  const [advertiser, agent] = await Promise.all([
    getAdvertiserForUser(userId),
    findWorkingAgentProfile(userId),
  ]);
  return {
    userId,
    isAdmin: req.user!.roles.includes('ADMIN'),
    advertiserId: advertiser?.id ?? null,
    agentId: agent?.id ?? null,
  };
}

/** The shape every sale endpoint answers with. */
const shape = (sale: SaleRow, commission: Money | null = null) => ({
  id: sale.id,
  /** The agent's recorded PACKAGE_SOLD, as money. Null when none was recorded. */
  commission,
  reference: sale.reference,
  advertiserId: sale.advertiserId,
  advertiserName: sale.advertiser.companyName ?? sale.advertiser.name,
  agentId: sale.agentId,
  tier: sale.tier,
  packageName: sale.packageName,
  cycle: sale.cycle,
  months: sale.months,
  pricePerMonth: money(sale.pricePerMonth),
  addOnsPerMonth: money(sale.addOnsPerMonth),
  subtotal: money(sale.subtotal),
  discountPct: money(sale.discountPct),
  discountAmount: money(sale.discountAmount),
  gstPct: money(sale.gstPct),
  gstAmount: money(sale.gstAmount),
  total: money(sale.total),
  status: sale.status,
  paymentUrl: paymentUrl(sale.paymentToken),
  paymentLinkSentAt: sale.paymentLinkSentAt,
  paymentLinkSends: sale.paymentLinkSends,
  channels: sendChannels(sale),
  paidAt: sale.paidAt,
  paidMethod: sale.paidMethod,
  /** Lot J2: the advertiser's own auto-renew switch. */
  autoRenew: sale.autoRenew,
  startsAt: sale.startsAt,
  endsAt: sale.endsAt,
  nextBillingAt: sale.nextBillingAt,
  createdAt: sale.createdAt,
  lines: sale.lines.map((line) => ({
    kind: line.kind,
    code: line.code,
    label: line.label,
    pricePerMonth: money(line.pricePerMonth),
    months: line.months,
    amount: money(line.amount),
  })),
});

/* ── Catalogue and pricing ───────────────────────────────────────── */

/* E7-3: `?includeInactive=true` lists the retired rows too — ADMIN only; anyone
 * else gets the active catalogue whatever the flag says. */
export async function catalogueHandler(req: Request, res: Response): Promise<void> {
  const includeInactive = req.query['includeInactive'] === 'true' && req.user!.roles.includes('ADMIN');
  res.json({ success: true, data: await listCatalogue({ includeInactive }) });
}

/**
 * Lot J2: the policy rides beside the money, so the phone prints rules it
 * did not compute. Lot K (B2): so does the term — `{ rule, startsAt,
 * endsAt, replaces, prorationAmount }` for the advertiser in the session,
 * or the one an agent names with `?advertiserId=` (an advertiser they
 * hold, the same check `GET /active` makes); an admin naming nobody gets
 * `term: null`.
 */
export async function quoteHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof quoteSchema>>(quoteSchema, req.body);
  const actor = await resolveActor(req);
  const advertiserId = await advertiserInScope(req, actor);
  const { priced, policy, term } = await quote({ ...body, advertiserId });
  res.json({ success: true, data: { ...priced, policy, term } });
}

/**
 * The advertiser a read is about: `?advertiserId=` when named, else the
 * session's own. An agent may name an advertiser they hold — not any they
 * can spell; an admin may name anyone. Null when nobody is in scope.
 */
async function advertiserInScope(req: Request, actor: SaleActor): Promise<string | null> {
  const named = typeof req.query['advertiserId'] === 'string' ? (req.query['advertiserId'] as string) : undefined;
  const advertiserId = named ?? actor.advertiserId;
  if (!advertiserId) return null;
  if (!actor.isAdmin && actor.advertiserId !== advertiserId) {
    if (!actor.agentId) throw new ApiError(403, 'FORBIDDEN', 'That is not your account.');
    const context = await repository.advertiserContext(advertiserId);
    if (!context) throw new ApiError(404, 'NOT_FOUND', 'Advertiser not found');
    if (context.agentId !== actor.agentId) throw new ApiError(403, 'FORBIDDEN', 'You can only quote for advertisers you look after.');
  }
  return advertiserId;
}

/* Lot D (Q94): the catalogue editor. ADMIN at the route; audited in the service. */

export async function updatePlanHandler(req: Request, res: Response): Promise<void> {
  const tier = parse<z.infer<typeof tierParamSchema>>(tierParamSchema, req.params['tier']);
  const patch = parse<z.infer<typeof updatePlanSchema>>(updatePlanSchema, req.body);
  const plan = await updatePlan(tier, patch, { userId: req.user!.sub, req });
  res.json({ success: true, data: { ...plan, pricePerMonth: money(plan.pricePerMonth) } });
}

export async function createAddOnHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof createAddOnSchema>>(createAddOnSchema, req.body);
  const addOn = await createAddOn(body, { userId: req.user!.sub, req });
  res.status(201).json({ success: true, data: { ...addOn, pricePerMonth: money(addOn.pricePerMonth) } });
}

export async function updateAddOnHandler(req: Request, res: Response): Promise<void> {
  const patch = parse<z.infer<typeof updateAddOnSchema>>(updateAddOnSchema, req.body);
  const addOn = await updateAddOn(req.params['code'] as string, patch, { userId: req.user!.sub, req });
  res.json({ success: true, data: { ...addOn, pricePerMonth: money(addOn.pricePerMonth) } });
}

/* ── The sale ────────────────────────────────────────────────────── */

export async function sellHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof sellSchema>>(sellSchema, req.body);
  const actor = await resolveActor(req);

  const advertiserId = body.advertiserId ?? actor.advertiserId;
  if (!advertiserId) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Say which advertiser this package is for. Your account is not an advertiser.'
    );
  }

  // An agent may only sell to an advertiser they hold; an advertiser only to
  // themselves. Checked here rather than trusted from the body.
  if (!actor.isAdmin) {
    if (actor.advertiserId && actor.advertiserId === advertiserId) {
      // Buying for themselves. Nothing more to check.
    } else if (actor.agentId) {
      const context = await repository.advertiserContext(advertiserId);
      if (!context) throw new ApiError(404, 'NOT_FOUND', 'Advertiser not found');
      if (context.agentId !== actor.agentId) {
        throw new ApiError(
          403,
          'FORBIDDEN',
          'You can only sell packages to advertisers you look after.'
        );
      }
    } else {
      throw new ApiError(403, 'FORBIDDEN', 'Only an advertiser or their agent can buy a package.');
    }
  }

  const sale = await sellPackage(
    { advertiserId, tier: body.tier, addOnCodes: body.addOnCodes, cycle: body.cycle, visitId: body.visitId ?? null },
    actor
  );
  res.status(201).json({ success: true, data: shape(sale) });
}

export async function listSalesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof listSalesQuerySchema>>(listSalesQuerySchema, req.query);
  const actor = await resolveActor(req);
  const page = await listSalesPage(actor, query);
  const commissions = await commissionsFor(page.items);
  // The page travels whole: the agent's book prints its own count and labels
  // Active / Expiring / Expired from `counts`.
  res.json({ success: true, data: { ...page, items: page.items.map((sale) => shape(sale, commissions.get(sale.id) ?? null)) } });
}

export async function getSaleHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const sale = await getSale(req.params['id'] as string, actor);
  const [commissions, terms] = await Promise.all([commissionsFor([sale]), saleTermsStanding(sale.id)]);
  // Lot D (Q123): where the sale stands on its terms rides on the read, so
  // the payment screen can show the gate before the advertiser reaches it.
  res.json({ success: true, data: { ...shape(sale, commissions.get(sale.id) ?? null), agreements: [terms] } });
}

/**
 * Lot D (Q123): the advertiser — or their agent under a live grant — accepts
 * the package terms for this sale. Rendered server-side from the live
 * PACKAGE_SALE template and the sale; once per sale per version.
 */
export async function acceptTermsHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const sale = await getSale(req.params['id'] as string, actor);
  await assertMayAcceptTerms(sale, actor);
  const result = await acceptSaleTerms(sale, {
    acceptedByUserId: actor.userId,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  });
  res.json({ success: true, data: result });
}

export async function resendHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const sale = await getSale(req.params['id'] as string, actor);
  const resent = await sendPaymentLink(sale.id);
  res.json({ success: true, data: shape(resent) });
}

export async function cancelHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof cancelSchema>>(cancelSchema, req.body);
  const actor = await resolveActor(req);
  const sale = await getSale(req.params['id'] as string, actor);
  res.json({ success: true, data: shape(await cancelSale(sale.id, body.reason)) });
}

/* ── Payment ─────────────────────────────────────────────────────── */

/**
 * The advertiser pays, from their own wallet.
 *
 * Only the advertiser the sale is for — not their agent, and not an admin
 * acting as them. Spending somebody's wallet is the one thing an agent must
 * never be able to do on their behalf.
 */
export async function payHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const sale = await getSale(req.params['id'] as string, actor);

  if (!actor.advertiserId || actor.advertiserId !== sale.advertiserId) {
    throw new ApiError(403, 'FORBIDDEN', 'Only the advertiser can pay for their own package.');
  }
  if (sale.status === 'ACTIVE') {
    res.json({ success: true, data: shape(sale) });
    return;
  }
  // Lot J2 (7): the rail the policy may have closed, before anything else is asked.
  await assertWalletPaymentOffered();
  // Before the wallet, never after it: markPaid refuses a cancelled or expired
  // sale in a second transaction, by which point the money has already moved.
  assertPayable(sale);
  // Lot D (Q123): and the terms, on the version live now, before any money.
  await assertSaleTermsAccepted(sale.id);

  await payForPackage(
    sale.advertiserId,
    sale.id,
    money(sale.total),
    `${sale.packageName} plan — ${sale.reference}`
  );
  const paid = await markPaid(sale.id, { method: 'WALLET', reference: sale.id });
  res.json({ success: true, data: shape(paid) });
}

/** An admin records a payment that arrived outside ADX — a transfer, a cheque. */
export async function recordPaymentHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof markPaidSchema>>(markPaidSchema, req.body);
  if (body.method === 'OFFLINE' && !body.reference?.trim()) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'An offline payment needs its bank or cheque reference.'
    );
  }
  // Lot A BLOCK_NEW: money that arrived outside ADX does not start a plan for a
  // suspended advertiser. Checked on the sale rather than through the booking
  // gate, because an offline transfer has no KYC or funds question to answer.
  const existing = await findSale(req.params['id'] as string);
  if (existing) await assertNotSuspended(existing.advertiserId);
  // Lot D (Q123): money that arrived outside ADX still needs the terms accepted.
  if (existing && existing.status !== 'ACTIVE') await assertSaleTermsAccepted(existing.id);

  const sale = await markPaid(req.params['id'] as string, {
    method: body.method,
    reference: body.reference ?? null,
  });
  res.json({ success: true, data: shape(sale) });
}

/* ── Reading ─────────────────────────────────────────────────────── */

export async function activePackageHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const advertiserId = (req.query['advertiserId'] as string | undefined) ?? actor.advertiserId;
  if (!advertiserId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say which advertiser to read.');
  }
  /*
   * An agent may read the plan of an advertiser they hold — not of any
   * advertiser they can name. Holding an agent profile is not the same
   * question as holding this account, and the same lookup sellHandler makes
   * is the one that answers it.
   */
  if (!actor.isAdmin && actor.advertiserId !== advertiserId) {
    if (!actor.agentId) {
      throw new ApiError(403, 'FORBIDDEN', 'That is not your account.');
    }
    const context = await repository.advertiserContext(advertiserId);
    if (!context) throw new ApiError(404, 'NOT_FOUND', 'Advertiser not found');
    if (context.agentId !== actor.agentId) {
      throw new ApiError(403, 'FORBIDDEN', 'You can only read plans for advertisers you look after.');
    }
  }
  res.json({ success: true, data: await activePackageWithOptions(advertiserId) });
}

/** Lot J2 (6): `PATCH /packages/active { autoRenew }` — the advertiser themselves, on their running plan. */
export async function setAutoRenewHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof autoRenewSchema>>(autoRenewSchema, req.body);
  const actor = await resolveActor(req);
  if (!actor.advertiserId) throw new ApiError(403, 'FORBIDDEN', 'Only the advertiser can switch auto-renew on their own package.');
  res.json({ success: true, data: shape(await setActivePackageAutoRenew(actor.advertiserId, body.autoRenew)) });
}

/** Lot J2 (5): `POST /packages/sales/trial { tier }` — the advertiser themselves starts a free trial. */
export async function startTrialHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof trialSchema>>(trialSchema, req.body);
  const actor = await resolveActor(req);
  if (!actor.advertiserId) throw new ApiError(403, 'FORBIDDEN', 'Only an advertiser can start a free trial, for themselves.');
  res.status(201).json({ success: true, data: shape(await startPackageTrial({ advertiserId: actor.advertiserId, userId: actor.userId, tier: body.tier })) });
}

/**
 * What the payment link resolves to. No authentication: it is a link in an SMS,
 * and the view is thin enough that guessing a token buys nothing.
 */
export async function publicLinkHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await publicSaleView(req.params['token'] as string) });
}
