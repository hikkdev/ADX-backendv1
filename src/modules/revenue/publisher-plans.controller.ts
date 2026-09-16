import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { findPublisherForUser } from '../publishers';
import {
  cancelSubscriptionOrder,
  createSubscriptionOrder,
  getSubscriptionOrder,
  listPlans,
  listSubscriptionOrdersPage,
  listSubscriptionsPage,
  mySubscription,
  orderView,
  paySubscriptionOrderFromWallet,
  quoteSubscriptionOrder,
  recordSubscriptionOrderPayment,
  setMySubscriptionAutoRenew,
  startSubscriptionTrial,
  updatePlan,
  type OrderActor,
} from './publisher-plans.service';
import {
  autoRenewSchema,
  createOrderSchema,
  listOrdersQuerySchema,
  listSubscriptionsQuerySchema,
  orderQuoteSchema,
  recordOrderPaymentSchema,
  tierSchema,
  trialSchema,
  updatePlanSchema,
} from './publisher-plans.schema';

/** Lot J (B1): the plan catalogue, its editor, and the self-service orders. */

const ok = (res: Response, data: unknown, status = 200): void => {
  res.status(status).json({ success: true, data });
};

function parse<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error?.flatten());
  }
  return parsed.data;
}

function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== 'string' || value.length === 0) throw new ApiError(400, 'BAD_REQUEST', `Missing ${key}`);
  return value;
}

const isAdmin = (req: Request): boolean => req.user?.roles.includes('ADMIN') ?? false;

/** The publisher is resolved from the session, never the body. */
async function resolveActor(req: Request): Promise<OrderActor> {
  const userId = req.user?.sub;
  if (!userId) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
  const publisher = await findPublisherForUser(userId);
  return { userId, isAdmin: isAdmin(req), publisherId: publisher?.id ?? null };
}

async function publisherActor(req: Request): Promise<OrderActor & { publisherId: string }> {
  const actor = await resolveActor(req);
  if (!actor.publisherId) throw new ApiError(404, 'NOT_FOUND', 'No publisher account for this user');
  return { ...actor, publisherId: actor.publisherId };
}

/* ── The catalogue ───────────────────────────────────────────────── */

export async function listPlansHandler(req: Request, res: Response): Promise<void> {
  // The retired rows are the console's business; the phone reads active only.
  const includeInactive = req.query['includeInactive'] === 'true' && isAdmin(req);
  ok(res, await listPlans({ includeInactive }));
}

export async function updatePlanHandler(req: Request, res: Response): Promise<void> {
  const tier = parse(tierSchema, param(req, 'tier'));
  const patch = parse(updatePlanSchema, req.body);
  ok(res, await updatePlan(tier, patch, { userId: req.user!.sub, req }));
}

/* ── Orders ──────────────────────────────────────────────────────── */

export async function quoteOrderHandler(req: Request, res: Response): Promise<void> {
  const body = parse(orderQuoteSchema, req.body);
  const actor = await publisherActor(req);
  ok(res, await quoteSubscriptionOrder({ publisherId: actor.publisherId, tier: body.tier, cycle: body.cycle }));
}

export async function createOrderHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createOrderSchema, req.body);
  const actor = await publisherActor(req);
  ok(res, await createSubscriptionOrder({ publisherId: actor.publisherId, userId: actor.userId, tier: body.tier, cycle: body.cycle }), 201);
}

export async function getOrderHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  ok(res, orderView(await getSubscriptionOrder(param(req, 'id'), actor)));
}

export async function payOrderHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  ok(res, await paySubscriptionOrderFromWallet(param(req, 'id'), actor));
}

export async function cancelOrderHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  ok(res, await cancelSubscriptionOrder(param(req, 'id'), actor, new Date(), req));
}

export async function recordOrderPaymentHandler(req: Request, res: Response): Promise<void> {
  const body = parse(recordOrderPaymentSchema, req.body);
  ok(res, await recordSubscriptionOrderPayment(param(req, 'id'), body, { userId: req.user!.sub, req }));
}

export async function listOrdersHandler(req: Request, res: Response): Promise<void> {
  const query = parse(listOrdersQuerySchema, req.query);
  ok(res, await listSubscriptionOrdersPage(query));
}

/** Lot J2 (5): a first-ever subscriber starts a free trial — PAID at once, total 0, method TRIAL. */
export async function startTrialHandler(req: Request, res: Response): Promise<void> {
  const body = parse(trialSchema, req.body);
  const actor = await publisherActor(req);
  ok(res, await startSubscriptionTrial({ publisherId: actor.publisherId, userId: actor.userId, tier: body.tier }), 201);
}

/* ── The phone's screen ──────────────────────────────────────────── */

export async function mySubscriptionHandler(req: Request, res: Response): Promise<void> {
  const actor = await publisherActor(req);
  ok(res, await mySubscription(actor.publisherId));
}

/** Lot J2 (6): `PATCH /revenue/subscriptions/me { autoRenew }` — the flag on the running row. */
export async function setAutoRenewHandler(req: Request, res: Response): Promise<void> {
  const body = parse(autoRenewSchema, req.body);
  const actor = await publisherActor(req);
  ok(res, await setMySubscriptionAutoRenew(actor.publisherId, body.autoRenew));
}

/* ── The console's list (Lot J2, d) ──────────────────────────────── */

export async function listSubscriptionsPageHandler(req: Request, res: Response): Promise<void> {
  const query = parse(listSubscriptionsQuerySchema, req.query);
  ok(res, await listSubscriptionsPage(query));
}
