import type { Request, Response } from 'express';
import { actorLabelFor } from '../access-control';
import { doorProvenance, selfProvenance } from '../../shared/onboarding';
import type { ZodType } from 'zod';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { isVerifiedParty } from '../../shared/kyc-state';
import { money } from '../../shared/money';
import { pageQueryFrom } from '../../shared/pagination';
import { findAgentProfile } from '../agents';
import { assertMayActFor } from './advertisers.policy';
import { prismaAdvertisersRepository } from './prisma-advertisers.repository';
import {
  acceptInsertionOrder,
  acceptPlatformAgreement,
  advertiserFunnel,
  advertiserFunnelRows,
  applyKycDecision,
  bookingEligibility,
  captureCampaignHold,
  createBrand,
  creditGoodwill,
  decideRefund,
  expireDormantCredit,
  failRefund,
  getAdvertiserDetail,
  getAdvertiserForUser,
  getWallet,
  holdForCampaign,
  listAdvertisers,
  listRefundRequests,
  listRefundRequestsPage,
  listTopUps,
  listTopUpsPage,
  listAdvertiserRefundRequests,
  markRefundPaid,
  refundableAmount,
  registerAdvertiser,
  releaseCampaignHold,
  requestRefund,
  topUp,
  updateBrand,
  updateProfile,
  walletStatement,
  withdrawRefund,
  setAdvertiserBand,
} from './advertisers.service';
import {
  createBrandSchema,
  failRefundSchema,
  goodwillSchema,
  holdSchema,
  insertionOrderSchema,
  decideRefundSchema,
  kycDecisionSchema,
  markRefundPaidSchema,
  refundDeskQuerySchema,
  topUpDeskQuerySchema,
  refundStatusSchema,
  registerAdvertiserSchema,
  advertiserRosterQuerySchema,
  ADVERTISER_INDUSTRIES,
  requestRefundSchema,
  topUpSchema,
  updateBrandSchema,
  updateProfileSchema,
  partyBandSchema,
} from './advertisers.schema';

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error.flatten());
  }
  return result.data;
}

const actor = (req: Request): string => {
  const sub = req.user?.sub;
  if (!sub) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue');
  return sub;
};

/** Everything an acceptance has to record about how it happened. */
const acceptanceContext = (req: Request) => ({
  acceptedByUserId: actor(req),
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const id = (req: Request, key = 'id'): string => {
  // Express types this as string | string[]: a repeated param yields an array.
  const value = req.params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', `Missing ${key}`);
  }
  return value;
};


/* Refunds ----------------------------------------------------------- */

export async function refundableHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: { refundable: await refundableAmount(id(req)) } });
}

export async function listRefundsHandler(req: Request, res: Response): Promise<void> {
  const raw = req.query['status'];
  const parsed = typeof raw === 'string' ? refundStatusSchema.safeParse(raw) : null;
  res.json({
    success: true,
    data: await listRefundRequests(
      pageQueryFrom(req.query),
      parsed?.success ? parsed.data : undefined
    ),
  });
}

/** The refund desk's queue (Lot B): `GET /finance/refund-requests?status=`. */
export async function refundDeskHandler(req: Request, res: Response): Promise<void> {
  const query = parse(refundDeskQuerySchema, req.query);
  res.json({ success: true, data: await listRefundRequestsPage(query) });
}

/** E6: the finance desk's top-up register: `GET /finance/top-ups?q=&from=&to=&status=`. */
export async function topUpDeskHandler(req: Request, res: Response): Promise<void> {
  const query = parse(topUpDeskQuerySchema, req.query);
  res.json({ success: true, data: await listTopUpsPage(query) });
}

/** E6: the advertiser's own refund requests — owner or their agent, READ. */
export async function listAdvertiserRefundRequestsHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  const query = parse(refundDeskQuerySchema, req.query);
  res.json({ success: true, data: await listAdvertiserRefundRequests(id(req), query) });
}

export async function requestRefundHandler(req: Request, res: Response): Promise<void> {
  const input = parse(requestRefundSchema, req.body);
  const request = await requestRefund(id(req), input, actor(req));
  await logActivity(actor(req), 'REFUND_REQUEST_RAISED', {
    req,
    module: 'advertisers',
    targetType: 'WalletRefundRequest',
    targetId: request.id,
    metadata: {
      advertiserId: id(req),
      walletId: request.walletId,
      amount: money(request.amount),
      destination: request.destination,
      reason: request.reason,
    },
  });
  res.status(201).json({ success: true, data: request });
}

export async function decideRefundHandler(req: Request, res: Response): Promise<void> {
  const { approve, decisionNote } = parse(decideRefundSchema, req.body);
  const decided = await decideRefund(id(req, 'requestId'), approve, actor(req), decisionNote);
  await logActivity(actor(req), approve ? 'REFUND_REQUEST_APPROVED' : 'REFUND_REQUEST_REJECTED', {
    req,
    module: 'advertisers',
    targetType: 'WalletRefundRequest',
    targetId: decided.id,
    diff: auditDiff({ status: 'PENDING' }, { status: decided.status }),
    metadata: {
      walletId: decided.walletId,
      amount: money(decided.amount),
      destination: decided.destination,
      decisionNote: decided.decisionNote,
      ledgerTransactionId: decided.ledgerTransactionId,
    },
  });
  res.json({ success: true, data: decided });
}

export async function markRefundPaidHandler(req: Request, res: Response): Promise<void> {
  const { railReference } = parse(markRefundPaidSchema, req.body);
  const paid = await markRefundPaid(id(req, 'requestId'), { railReference, byUserId: actor(req) });
  await logActivity(actor(req), 'REFUND_REQUEST_PAID', {
    req,
    module: 'advertisers',
    targetType: 'WalletRefundRequest',
    targetId: paid.id,
    diff: auditDiff(
      { status: 'APPROVED', railReference: null },
      { status: paid.status, railReference: paid.railReference }
    ),
    metadata: { walletId: paid.walletId, amount: money(paid.amount), rail: paid.rail },
  });
  res.json({ success: true, data: paid });
}

export async function failRefundHandler(req: Request, res: Response): Promise<void> {
  const { reason } = parse(failRefundSchema, req.body);
  const failed = await failRefund(id(req, 'requestId'), { reason, byUserId: actor(req) });
  await logActivity(actor(req), 'REFUND_REQUEST_FAILED', {
    req,
    module: 'advertisers',
    targetType: 'WalletRefundRequest',
    targetId: failed.id,
    diff: auditDiff({ status: 'APPROVED' }, { status: failed.status }),
    metadata: { walletId: failed.walletId, amount: money(failed.amount), reason },
  });
  res.json({ success: true, data: failed });
}

export async function withdrawRefundHandler(req: Request, res: Response): Promise<void> {
  const withdrawn = await withdrawRefund(id(req, 'requestId'));
  await logActivity(actor(req), 'REFUND_REQUEST_WITHDRAWN', {
    req,
    module: 'advertisers',
    targetType: 'WalletRefundRequest',
    targetId: withdrawn.id,
    diff: auditDiff({ status: 'PENDING' }, { status: withdrawn.status }),
  });
  res.json({ success: true, data: withdrawn });
}

/* Dormancy ---------------------------------------------------------- */

export async function expireCreditHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await expireDormantCredit() });
}

/* Accounts --------------------------------------------------------- */

export async function listAdvertisersHandler(req: Request, res: Response): Promise<void> {
  // E7-3: `?q=` beside limit/cursor — name, company, email, mobile or displayId contains.
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim().slice(0, 120) : '';
  // QR-15: the roster's cuts — the door, and the person who opened it.
  const cuts = parse(advertiserRosterQuerySchema, req.query);
  res.json({
    success: true,
    data: await listAdvertisers({
      ...pageQueryFrom(req.query),
      ...(q ? { q } : {}),
      ...(cuts.onboardedVia ? { onboardedVia: cuts.onboardedVia } : {}),
      ...(cuts.onboardedById ? { onboardedById: cuts.onboardedById } : {}),
    }),
  });
}

export async function getAdvertiserHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  // E6: with the account's closure state.
  res.json({ success: true, data: await getAdvertiserDetail(id(req)) });
}

/** GET /advertisers/industries — Lot G (Q119): the picklist, a constant list in code. */
export async function industriesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: [...ADVERTISER_INDUSTRIES] });
}

export async function meHandler(req: Request, res: Response): Promise<void> {
  const advertiser = await getAdvertiserForUser(actor(req));
  // QR-3: the verified mark every external party earns the same way — the
  // app draws a tick beside the name on it.
  res.json({ success: true, data: advertiser ? { ...advertiser, verified: isVerifiedParty(advertiser.kycStatus) } : advertiser });
}

export async function registerAdvertiserHandler(req: Request, res: Response): Promise<void> {
  const { onBehalf, ...input } = parse(registerAdvertiserSchema, req.body);
  const caller = actor(req);

  // An account opened by an agent is held for someone who has not registered
  // yet, so it must not be linked to the agent's own user — that would make
  // GET /advertisers/me return their customer's account. A self-serve signup
  // links to the caller, which is exactly what makes /me resolve.
  // QR-14: the door — the app's own, an agent at the door, or the desk.
  const roles = req.user?.roles ?? [];
  const agentId = onBehalf ? await resolveAgent(caller) : null;
  const data = onBehalf
    ? { ...input, userId: null, agentId, ...doorProvenance(agentId ? 'AGENT' : 'DESK', caller, await actorLabelFor(caller, roles)) }
    : { ...input, userId: caller, agentId: null, ...selfProvenance() };

  res.status(201).json({ success: true, data: await registerAdvertiser(data) });
}

/** Null when the caller is an admin rather than an agent — attribution is optional. */
async function resolveAgent(userId: string): Promise<string | null> {
  return prismaAdvertisersRepository.findAgentProfileId(userId);
}

export async function updateProfileHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'WRITE', 'ADVERTISER_PROFILE_UPDATED');
  const patch = parse(updateProfileSchema, req.body);
  res.json({ success: true, data: await updateProfile(id(req), patch) });
}

export async function kycDecisionHandler(req: Request, res: Response): Promise<void> {
  const { status } = parse(kycDecisionSchema, req.body);
  res.json({ success: true, data: await applyKycDecision(id(req), status) });
}

export async function eligibilityHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  const amount = typeof req.query['amount'] === 'string' ? req.query['amount'] : undefined;
  res.json({ success: true, data: await bookingEligibility(id(req), amount) });
}

/* Funnel ----------------------------------------------------------- */

export async function funnelHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await advertiserFunnel() });
}

export async function funnelRowsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await advertiserFunnelRows(pageQueryFrom(req.query)) });
}

/* Agreements ------------------------------------------------------- */

export async function acceptPlatformHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'WRITE', 'ADVERTISER_AGREEMENT_ACCEPTED');
  res.json({ success: true, data: await acceptPlatformAgreement(id(req), acceptanceContext(req)) });
}

export async function acceptInsertionOrderHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'WRITE', 'ADVERTISER_INSERTION_ORDER_ACCEPTED');
  const { campaignId } = parse(insertionOrderSchema, req.body);
  res.json({
    success: true,
    data: await acceptInsertionOrder(id(req), campaignId, acceptanceContext(req)),
  });
}

/* Brands ----------------------------------------------------------- */

export async function createBrandHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'WRITE', 'ADVERTISER_BRAND_CREATED');
  const input = parse(createBrandSchema, req.body);
  res.status(201).json({ success: true, data: await createBrand(id(req), input) });
}

export async function updateBrandHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'WRITE', 'ADVERTISER_BRAND_UPDATED');
  const patch = parse(updateBrandSchema, req.body);
  res.json({ success: true, data: await updateBrand(id(req, 'brandId'), patch) });
}

/* Wallet ----------------------------------------------------------- */

export async function walletHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  res.json({ success: true, data: await getWallet(id(req)) });
}

export async function statementHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  res.json({ success: true, data: await walletStatement(id(req), pageQueryFrom(req.query)) });
}

/**
 * Lot B (Q41/Q118): ops records a transfer or a cheque against the wallet.
 * Audited against the Wallet, with the balance before and after — the row a
 * reconciliation dispute is settled from.
 */
export async function topUpHandler(req: Request, res: Response): Promise<void> {
  const input = parse(topUpSchema, req.body);
  const before = await getWallet(id(req));
  const outcome = await topUp(id(req), input, actor(req));
  await logActivity(actor(req), 'WALLET_TOPUP_RECORDED', {
    req,
    module: 'advertisers',
    targetType: 'Wallet',
    targetId: outcome.topUp.walletId,
    diff: auditDiff({ balance: before.balance }, { balance: outcome.wallet.balance }),
    metadata: {
      advertiserId: id(req),
      topUpId: outcome.topUp.id,
      amount: money(outcome.topUp.amount),
      method: outcome.topUp.method,
      utr: outcome.topUp.utr,
      receivedAt: outcome.topUp.receivedAt.toISOString(),
      bankAccountId: outcome.topUp.bankAccountId,
      proofFileId: outcome.topUp.proofFileId,
      ledgerTransactionId: outcome.topUp.ledgerTransactionId,
    },
  });
  res.status(201).json({
    success: true,
    data: { ...outcome, topUp: { ...outcome.topUp, amount: money(outcome.topUp.amount) } },
  });
}

export async function listTopUpsHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'READ');
  const page = await listTopUps(id(req), pageQueryFrom(req.query));
  res.json({
    success: true,
    data: { ...page, rows: page.rows.map((row) => ({ ...row, amount: money(row.amount) })) },
  });
}

export async function holdHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'WRITE', 'ADVERTISER_HOLD_PLACED');
  const { campaignId, amount } = parse(holdSchema, req.body);
  res.status(201).json({ success: true, data: await holdForCampaign(id(req), campaignId, amount) });
}

export async function captureHoldHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await captureCampaignHold(id(req, 'holdId')) });
}

export async function releaseHoldHandler(req: Request, res: Response): Promise<void> {
  await assertMayActFor(req, id(req), 'WRITE', 'ADVERTISER_HOLD_RELEASED');
  res.json({ success: true, data: await releaseCampaignHold(id(req, 'holdId')) });
}

export async function goodwillHandler(req: Request, res: Response): Promise<void> {
  const { amount, campaignId, note } = parse(goodwillSchema, req.body);
  const before = await getWallet(id(req));
  const after = await creditGoodwill(id(req), amount, campaignId, note, { byUserId: actor(req) });
  await logActivity(actor(req), 'WALLET_GOODWILL_CREDITED', {
    req,
    module: 'advertisers',
    targetType: 'Advertiser',
    targetId: id(req),
    diff: auditDiff({ goodwill: before.goodwill }, { goodwill: after.goodwill }),
    metadata: { amount, campaignId: campaignId ?? null, note: note ?? null },
  });
  res.json({ success: true, data: after });
}

/** AG-5: the desk sets the advertiser's band. */
export async function setAdvertiserBandHandler(req: Request, res: Response): Promise<void> {
  const { sizeBand } = parse(partyBandSchema, req.body);
  res.json({ success: true, data: await setAdvertiserBand(id(req), req.user!.sub, sizeBand, req) });
}
