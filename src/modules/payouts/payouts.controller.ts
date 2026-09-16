import type { Request, Response } from 'express';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { money } from '../../shared/money';
import { listTransactions, reverse, verifyLedger } from '../ledger';
import { listEntries, listWallets, snapshot } from '../wallets';
import {
  addMethod,
  approveWithdrawal,
  availableRails,
  cancelWithdrawal,
  failWithdrawal,
  ifscLookup,
  listMethods,
  listMethodsAwaitingReview,
  listWithdrawals,
  markWithdrawalPaid,
  partyContext,
  rejectMethod,
  rejectWithdrawal,
  removeMethod,
  requestWithdrawal,
  requestWithdrawalOnBehalf,
  setDefaultMethod,
  verifyMethod,
  walletForUser,
  walletForUserOrOpen,
  withdrawalAllowance,
  withdrawalSummary,
} from './payouts.service';
import { shapeMethod, shapeWithdrawal } from './payouts.shape';
import {
  creditIncentive,
  incentiveSummary,
  listIncentiveRates,
  listIncentives,
  recordIncentive,
  rejectIncentive,
  setIncentiveRate,
} from './incentives.service';
import { earningsSummary, listAccruals, runDailyAccrual } from './accrual.service';
import { quantityBackfill } from './accrual-backfill.service';
import { listLimits, listTaxRates, setLimit, setTaxRate } from './rules.service';
import * as schema from './payouts.schema';

function parse<T>(s: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = s.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

const userId = (req: Request) => req.user!.sub;

/** The caller's own wallet, whichever party they are. */
async function myWallet(req: Request) {
  const found = await walletForUser(userId(req));
  if (!found) {
    throw new ApiError(
      404,
      'NOT_FOUND',
      'You do not have an ADX wallet yet. One opens when you first earn.'
    );
  }
  return found;
}

/* `shapeMethod` and `shapeWithdrawal` live in payouts.shape.ts, shared with the batch controller. */

/* ── Payout methods, the party's own ──────────────────────────────── */

export async function listMethodsHandler(req: Request, res: Response): Promise<void> {
  const methods = await listMethods(userId(req));
  res.json({ success: true, data: methods.map(shapeMethod) });
}

export async function addMethodHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.AddMethodInput>(schema.addMethodSchema, req.body);
  const method = await addMethod(userId(req), body);
  res.status(201).json({ success: true, data: shapeMethod(method) });
}

export async function removeMethodHandler(req: Request, res: Response): Promise<void> {
  await removeMethod(req.params['id'] as string, userId(req));
  res.json({ success: true, data: { removed: true } });
}

export async function setDefaultMethodHandler(req: Request, res: Response): Promise<void> {
  const method = await setDefaultMethod(req.params['id'] as string, userId(req));
  res.json({ success: true, data: shapeMethod(method) });
}

/**
 * Lot B (Q11/Q109): the branch behind an IFSC, for the add-account form.
 * A 503 when the directory did not answer — the form then lets the typed
 * bank stand, which is what `addMethod` does too.
 */
export async function ifscLookupHandler(req: Request, res: Response): Promise<void> {
  const answer = await ifscLookup(req.params['code'] as string);
  if (!answer) {
    throw new ApiError(
      503,
      'INTEGRATION_NOT_CONFIGURED',
      'The IFSC directory did not answer. The bank name you type will stand until it does.'
    );
  }
  res.json({
    success: true,
    data: answer.found
      ? answer
      : { ifsc: answer.ifsc, bank: null, branch: null, city: null, state: null, neft: false, imps: false, rtgs: false, found: false },
  });
}

/* ── The party's own wallet ───────────────────────────────────────── */

/** Lot J2 (f): a publisher who has never earned reads a zero snapshot — the wallet is opened on this read. */
export async function myWalletHandler(req: Request, res: Response): Promise<void> {
  const opened = await walletForUserOrOpen(userId(req));
  const wallet = opened ?? (await myWallet(req));
  const [balances, allowance] = await Promise.all([
    snapshot(wallet.id),
    withdrawalAllowance(wallet.id),
  ]);
  res.json({ success: true, data: { ...balances, kind: wallet.kind, allowance } });
}

export async function myEntriesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<{ limit?: number; cursor?: string; type?: string[] }>(schema.entriesQuerySchema, req.query);
  const wallet = await myWallet(req);
  const entries = await listEntries(wallet.id, {
    limit: query.limit ?? 50,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.type?.length ? { types: query.type as never } : {}),
  });
  res.json({
    success: true,
    data: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      amount: money(entry.amount),
      balanceAfter: money(entry.balanceAfter),
      isGoodwill: entry.isGoodwill,
      reference: entry.reference,
      note: entry.note,
      createdAt: entry.createdAt,
    })),
  });
}

/**
 * A publisher's earnings: the daily lines behind the balance.
 *
 * Returned together with the summary because the frame shows both at once —
 * what has been earned, and what is still inside its clearing window.
 */
export async function myEarningsHandler(req: Request, res: Response): Promise<void> {
  const wallet = await myWallet(req);
  const party = await partyContext(wallet.id);
  if (!party || party.kind !== 'PUBLISHER') {
    throw new ApiError(404, 'NOT_FOUND', 'Earnings are a publisher view.');
  }

  const [summary, days] = await Promise.all([
    earningsSummary(party.entityId),
    listAccruals(party.entityId, 120),
  ]);

  res.json({
    success: true,
    data: {
      summary,
      days: days.map((day) => ({
        id: day.id,
        forDate: day.forDate,
        listing: day.listing,
        gross: money(day.gross),
        commission: money(day.commission),
        taxWithheld: money(day.taxWithheld),
        net: money(day.net),
        clearsAt: day.clearsAt,
        cleared: day.clearsAt.getTime() <= Date.now(),
      })),
    },
  });
}

/** An agent's incentives: the three header figures, then the history. */
export async function myIncentivesHandler(req: Request, res: Response): Promise<void> {
  const wallet = await myWallet(req);
  const party = await partyContext(wallet.id);
  if (!party || party.kind !== 'AGENT') {
    throw new ApiError(404, 'NOT_FOUND', 'Incentives are an agent view.');
  }

  const query = parse<{ limit?: number; cursor?: string; event?: string[] }>(schema.incentivesQuerySchema, req.query);
  const limit = query.limit ?? 100;
  const [summary, rows] = await Promise.all([
    incentiveSummary(party.entityId),
    listIncentives({
      agentId: party.entityId,
      // One extra row tells us whether there is a next page without a count.
      limit: limit + 1,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.event?.length ? { events: query.event as never } : {}),
    }),
  ]);
  const history = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? history[history.length - 1]!.id : null;

  res.json({
    success: true,
    data: {
      summary,
      nextCursor,
      history: history.map((row) => ({
        id: row.id,
        event: row.event,
        amount: money(row.amount),
        taxWithheld: money(row.taxWithheld),
        netAmount: money(row.netAmount),
        status: row.status,
        note: row.note,
        rejectionReason: row.rejectionReason,
        createdAt: row.createdAt,
        verifiedAt: row.verifiedAt,
      })),
    },
  });
}

/* ── Withdrawal ───────────────────────────────────────────────────── */

export async function myWithdrawalsHandler(req: Request, res: Response): Promise<void> {
  const wallet = await myWallet(req);
  const rows = await listWithdrawals({ walletId: wallet.id });
  res.json({ success: true, data: rows.map(shapeWithdrawal) });
}

export async function requestWithdrawalHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ amount: string; payoutMethodId: string }>(
    schema.requestWithdrawalSchema,
    req.body
  );
  const wallet = await myWallet(req);
  const created = await requestWithdrawal(wallet.id, { ...body, userId: userId(req) });
  res.status(201).json({ success: true, data: shapeWithdrawal(created) });
}

export async function cancelWithdrawalHandler(req: Request, res: Response): Promise<void> {
  const row = await cancelWithdrawal(req.params['id'] as string, userId(req));
  res.json({ success: true, data: shapeWithdrawal(row) });
}

/* ── Finance: the admin side ──────────────────────────────────────── */

export async function adminWalletsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<{ kind?: 'PUBLISHER' | 'AGENT' | 'ADVERTISER' | 'PRINT_PARTNER'; limit?: number }>(
    schema.walletQuerySchema,
    req.query
  );
  const wallets = await listWallets(query);
  res.json({
    success: true,
    data: wallets.map((wallet) => ({
      id: wallet.id,
      kind: wallet.publisherId
        ? 'PUBLISHER'
        : wallet.agentId
          ? 'AGENT'
          : wallet.printPartnerId
            ? 'PRINT_PARTNER'
            : 'ADVERTISER',
      owner:
        wallet.publisher?.name ??
        wallet.printPartner?.name ??
        wallet.advertiser?.companyName ??
        wallet.advertiser?.name ??
        'Agent',
      displayId: wallet.publisher?.displayId ?? wallet.printPartner?.displayId ?? null,
      sizeBand: wallet.publisher?.sizeBand ?? null,
      balance: money(wallet.balance),
      goodwill: money(wallet.goodwill),
      lastActivityAt: wallet.lastActivityAt,
      // E6: the freeze (Lot A FREEZE_WALLET) on the row.
      frozenAt: wallet.frozenAt,
      frozenReason: wallet.frozenReason,
    })),
  });
}

export async function adminWalletHandler(req: Request, res: Response): Promise<void> {
  const walletId = req.params['id'] as string;
  const [balances, party, allowance, withdrawals] = await Promise.all([
    snapshot(walletId),
    partyContext(walletId),
    withdrawalAllowance(walletId).catch(() => null),
    listWithdrawals({ walletId, limit: 20 }),
  ]);
  res.json({
    success: true,
    data: {
      ...balances,
      party,
      allowance,
      withdrawals: withdrawals.map(shapeWithdrawal),
    },
  });
}

export async function adminWalletEntriesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<{ limit?: number; cursor?: string }>(schema.entriesQuerySchema, req.query);
  const entries = await listEntries(req.params['id'] as string, {
    limit: query.limit ?? 100,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  res.json({
    success: true,
    data: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      amount: money(entry.amount),
      balanceAfter: money(entry.balanceAfter),
      isGoodwill: entry.isGoodwill,
      reference: entry.reference,
      note: entry.note,
      createdAt: entry.createdAt,
    })),
  });
}

export async function adminWithdrawalsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<import('zod').infer<typeof schema.withdrawalQuerySchema>>(
    schema.withdrawalQuerySchema,
    req.query
  );
  const rows = await listWithdrawals({
    ...(query.status ? { status: query.status as never } : {}),
    ...(query.q ? { q: query.q } : {}),
    ...(query.partyKind ? { partyKind: query.partyKind } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(query.batchId ? { batchId: query.batchId } : {}),
    // E6: one party's lines, and the paid-out window.
    ...(query.walletId ? { walletId: query.walletId } : {}),
    ...(query.publisherId ? { publisherId: query.publisherId } : {}),
    ...(query.agentId ? { agentId: query.agentId } : {}),
    ...(query.paidFrom ? { paidFrom: query.paidFrom } : {}),
    ...(query.paidTo ? { paidTo: query.paidTo } : {}),
    ...(query.limit ? { limit: query.limit } : {}),
  });
  res.json({ success: true, data: rows.map(shapeWithdrawal) });
}

/** Lot B (Q140): the queue's header — rows per status, and how many the rail has held over a day. */
export async function withdrawalSummaryHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await withdrawalSummary() });
}

/**
 * Lot B (B4b): a withdrawal raised at the desk for a party who cannot raise
 * their own — a print partner. The ordinary rules apply unchanged; the row
 * lands REQUESTED and is vetted like any other. Audited against the request
 * with the wallet and the amount, and the note ops typed.
 */
export async function onBehalfWithdrawalHandler(req: Request, res: Response): Promise<void> {
  const body = parse<import('zod').infer<typeof schema.onBehalfWithdrawalSchema>>(
    schema.onBehalfWithdrawalSchema,
    req.body
  );
  const created = await requestWithdrawalOnBehalf({
    walletId: body.walletId,
    amount: body.amount,
    payoutMethodId: body.payoutMethodId ?? null,
    // E6: kept on the row as decisionNote, as well as in the audit metadata.
    note: body.note ?? null,
  });
  await logActivity(userId(req), 'WITHDRAWAL_REQUESTED_ON_BEHALF', {
    req,
    module: 'payouts',
    targetType: 'WithdrawalRequest',
    targetId: created.id,
    metadata: {
      walletId: created.walletId,
      reference: created.reference,
      amount: money(created.amount),
      payoutMethodId: created.payoutMethodId,
      ...(body.note ? { note: body.note } : {}),
    },
  });
  res.status(201).json({ success: true, data: shapeWithdrawal(created) });
}

export async function approveHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ note?: string; rail?: never }>(schema.decisionSchema, req.body ?? {});
  const row = await approveWithdrawal(req.params['id'] as string, {
    byUserId: userId(req),
    note: body.note ?? null,
    rail: body.rail ?? null,
  });
  res.json({ success: true, data: shapeWithdrawal(row) });
}

export async function rejectWithdrawalHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ reason: string }>(schema.rejectSchema, req.body);
  const row = await rejectWithdrawal(req.params['id'] as string, {
    byUserId: userId(req),
    reason: body.reason,
  });
  res.json({ success: true, data: shapeWithdrawal(row) });
}

export async function markPaidHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ railReference: string }>(schema.markPaidSchema, req.body);
  const row = await markWithdrawalPaid(req.params['id'] as string, {
    railReference: body.railReference,
    byUserId: userId(req),
  });
  res.json({ success: true, data: shapeWithdrawal(row) });
}

export async function failHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ reason: string }>(schema.failSchema, req.body);
  const row = await failWithdrawal(req.params['id'] as string, {
    reason: body.reason,
    byUserId: userId(req),
  });
  res.json({ success: true, data: shapeWithdrawal(row) });
}

/**
 * The verification queue — or, with `?userId=`, everything one party has,
 * whatever its state (D5: the agent's payouts tab in the console).
 */
export async function pendingMethodsHandler(req: Request, res: Response): Promise<void> {
  const { userId: forUser } = parse<{ userId?: string }>(schema.methodsQuerySchema, req.query);
  const methods = forUser ? await listMethods(forUser) : await listMethodsAwaitingReview();
  res.json({ success: true, data: methods.map(shapeMethod) });
}

/**
 * D5: a method recorded on a party's behalf. Agents never add their own
 * bank account — ops records the cancelled cheque at the desk — and the row
 * then waits for verification like any other.
 */
export async function adminAddMethodHandler(req: Request, res: Response): Promise<void> {
  const { userId: forUser } = parse<{ userId: string }>(schema.onBehalfSchema, req.body);
  const body = parse<schema.AddMethodInput>(schema.addMethodSchema, req.body);
  const method = await addMethod(forUser, body);
  res.status(201).json({ success: true, data: shapeMethod(method) });
}

export async function verifyMethodHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ via: never; reference?: string; nameMatchPct?: string }>(
    schema.verifyMethodSchema,
    req.body ?? {}
  );
  const method = await verifyMethod(req.params['id'] as string, {
    via: body.via,
    reference: body.reference ?? null,
    nameMatchPct: body.nameMatchPct ?? null,
    byUserId: userId(req),
  });
  res.json({ success: true, data: shapeMethod(method) });
}

export async function rejectMethodHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ reason: string }>(schema.rejectSchema, req.body);
  const method = await rejectMethod(req.params['id'] as string, body.reason, userId(req));
  res.json({ success: true, data: shapeMethod(method) });
}

/* ── Incentives ───────────────────────────────────────────────────── */

export async function adminIncentivesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<import('zod').infer<typeof schema.incentiveQuerySchema>>(
    schema.incentiveQuerySchema,
    req.query
  );
  const rows = await listIncentives({
    ...(query.agentId ? { agentId: query.agentId } : {}),
    ...(query.orderId ? { orderId: query.orderId } : {}),
    ...(query.status ? { status: query.status as never } : {}),
    // E6: the event facet and the desk's search.
    ...(query.event ? { events: query.event } : {}),
    ...(query.q ? { q: query.q } : {}),
    ...(query.limit ? { limit: query.limit } : {}),
  });
  res.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      // E6: the party the event was earned on (the columns Lot B wrote).
      publisherId: row.publisherId,
      advertiserId: row.advertiserId,
      event: row.event,
      tier: row.tier,
      amount: money(row.amount),
      taxWithheld: money(row.taxWithheld),
      netAmount: money(row.netAmount),
      status: row.status,
      orderId: row.orderId,
      note: row.note,
      verifiedAt: row.verifiedAt,
      rejectionReason: row.rejectionReason,
      createdAt: row.createdAt,
    })),
  });
}

export async function recordIncentiveHandler(req: Request, res: Response): Promise<void> {
  const body = parse<import('zod').infer<typeof schema.recordIncentiveSchema>>(schema.recordIncentiveSchema, req.body);
  const row = await recordIncentive(body);
  res.status(201).json({ success: true, data: { id: row.id, status: row.status } });
}

export async function creditIncentiveHandler(req: Request, res: Response): Promise<void> {
  const row = await creditIncentive(req.params['id'] as string, { byUserId: userId(req) });
  res.json({ success: true, data: { id: row.id, status: row.status } });
}

export async function rejectIncentiveHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ reason: string }>(schema.rejectSchema, req.body);
  const row = await rejectIncentive(req.params['id'] as string, {
    byUserId: userId(req),
    reason: body.reason,
  });
  res.json({ success: true, data: { id: row.id, status: row.status } });
}

/* ── Configuration ────────────────────────────────────────────────── */

export async function limitsHandler(_req: Request, res: Response): Promise<void> {
  const limits = await listLimits();
  res.json({
    success: true,
    data: limits.map((limit) => ({
      id: limit.id,
      band: limit.band,
      minMonths: limit.minMonths,
      dailyCap: money(limit.dailyCap),
    })),
  });
}

export async function setLimitHandler(req: Request, res: Response): Promise<void> {
  const body = parse<import('zod').infer<typeof schema.setLimitSchema>>(schema.setLimitSchema, req.body);
  const limit = await setLimit(body);
  res.json({ success: true, data: { id: limit.id, dailyCap: money(limit.dailyCap) } });
}

export async function taxRatesHandler(_req: Request, res: Response): Promise<void> {
  const rates = await listTaxRates();
  res.json({
    success: true,
    data: rates.map((rate) => ({
      id: rate.id,
      appliesTo: rate.appliesTo,
      section: rate.section,
      ratePct: money(rate.ratePct),
      effectiveFrom: rate.effectiveFrom,
      effectiveTo: rate.effectiveTo,
      note: rate.note,
    })),
  });
}

export async function setTaxRateHandler(req: Request, res: Response): Promise<void> {
  const body = parse<import('zod').infer<typeof schema.setTaxRateSchema>>(schema.setTaxRateSchema, req.body);
  const rate = await setTaxRate({
    appliesTo: body.appliesTo,
    section: body.section,
    ratePct: body.ratePct,
    effectiveFrom: body.effectiveFrom ?? new Date(),
    note: body.note ?? null,
  });
  res.json({ success: true, data: { id: rate.id, ratePct: money(rate.ratePct) } });
}

export async function incentiveRatesHandler(_req: Request, res: Response): Promise<void> {
  const rates = await listIncentiveRates();
  res.json({
    success: true,
    data: rates.map((rate) => ({
      id: rate.id,
      event: rate.event,
      tier: rate.tier,
      amount: money(rate.amount),
      effectiveFrom: rate.effectiveFrom,
      effectiveTo: rate.effectiveTo,
    })),
  });
}

export async function setIncentiveRateHandler(req: Request, res: Response): Promise<void> {
  const body = parse<import('zod').infer<typeof schema.setIncentiveRateSchema>>(schema.setIncentiveRateSchema, req.body);
  const rate = await setIncentiveRate({
    event: body.event,
    ...(body.tier ? { tier: body.tier } : {}),
    amount: body.amount,
    effectiveFrom: body.effectiveFrom ?? new Date(),
  });
  res.json({ success: true, data: { id: rate.id, amount: money(rate.amount) } });
}

/* ── Ledger and jobs ──────────────────────────────────────────────── */

export async function ledgerHandler(req: Request, res: Response): Promise<void> {
  const query = parse<import('zod').infer<typeof schema.ledgerQuerySchema>>(
    schema.ledgerQuerySchema,
    req.query
  );
  // E6: kind, window and amount facets for the ledger screen.
  const rows = await listTransactions({
    ...(query.walletId ? { walletId: query.walletId } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(query.amount ? { amount: query.amount } : {}),
    ...(query.limit ? { limit: query.limit } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  res.json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      kind: row.kind,
      occurredAt: row.occurredAt,
      note: row.note,
      reversesId: row.reversesId,
      legs: row.legs.map((leg) => ({
        accountCode: leg.account.code,
        accountName: leg.account.name,
        amount: money(leg.amount),
        note: leg.note,
      })),
    })),
  });
}

export async function reverseLedgerHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ reason: string }>(schema.rejectSchema, req.body);
  const row = await reverse(req.params['id'] as string, {
    reason: body.reason,
    createdByUserId: userId(req),
  });
  res.json({ success: true, data: { id: row.id, reference: row.reference } });
}

export async function verifyLedgerHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await verifyLedger() });
}

export async function runAccrualHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await runDailyAccrual() });
}

/**
 * Lot B (B1, Q135). A dry run lists; an execute posts one ADJUSTMENT per spot
 * and writes an `ACCRUAL_QUANTITY_CORRECTED` row against each spot. This row
 * is the run itself, so a dry run leaves a trace too.
 */
export async function quantityBackfillHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.QuantityBackfillInput>(schema.quantityBackfillSchema, req.body ?? {});
  const byUserId = userId(req);
  const result = await quantityBackfill({ dryRun: body.dryRun, byUserId, requestId: req.requestId });
  await logActivity(byUserId, 'ACCRUAL_QUANTITY_BACKFILL_RUN', {
    req,
    module: 'payouts',
    targetType: 'EarningAccrual',
    targetId: 'quantity-backfill',
    metadata: {
      dryRun: result.dryRun,
      spots: result.totals.spots,
      days: result.totals.days,
      missingGross: result.totals.missingGross,
      missingNet: result.totals.missingNet,
      alreadyCorrected: result.alreadyCorrected,
      corrected: result.corrected,
      failed: result.failed.length,
    },
  });
  res.json({ success: true, data: result });
}

export async function railsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: availableRails() });
}

export { earningsSummary, listAccruals, incentiveSummary };
