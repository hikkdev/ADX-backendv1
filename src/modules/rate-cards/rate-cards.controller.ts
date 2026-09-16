import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import {
  approvalListQuerySchema,
  cardListQuerySchema,
  createCardSchema,
  decideApprovalSchema,
  entriesSchema,
  impactDryRunSchema,
  quoteSchema,
  requestApprovalSchema,
  updateCardSchema,
} from './rate-cards.schema';
import {
  approveCard,
  archiveCard,
  assertMayAskGate,
  cardImpact,
  cardImpactDryRun,
  createCard,
  gateView,
  decideApproval,
  getCard,
  listApprovals,
  listApprovalsPage,
  listCards,
  quoteFromCard,
  rejectCard,
  requestApproval,
  reviseCard,
  setEntries,
  submitCard,
  updateCard,
} from './rate-cards.service';

const id = (req: Request, key = 'id') => req.params[key] as string;

const parse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: any } }, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
};

const dates = <T extends { effectiveFrom?: string | null; effectiveTo?: string | null }>(body: T) => ({
  ...body,
  effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : (body.effectiveFrom as null | undefined),
  effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : (body.effectiveTo as null | undefined),
});

export async function listCardsHandler(req: Request, res: Response): Promise<void> {
  const query = parse(cardListQuerySchema, req.query);
  res.json({ success: true, data: await listCards(query.status) });
}

export async function getCardHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getCard(id(req)) });
}

export async function createCardHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createCardSchema, req.body);
  res.status(201).json({ success: true, data: await createCard(dates(body)) });
}

export async function updateCardHandler(req: Request, res: Response): Promise<void> {
  const body = parse(updateCardSchema, req.body);
  res.json({ success: true, data: await updateCard(id(req), dates(body)) });
}

export async function setEntriesHandler(req: Request, res: Response): Promise<void> {
  const body = parse(entriesSchema, req.body);
  res.json({ success: true, data: await setEntries(id(req), body.entries) });
}

export async function submitCardHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await submitCard(id(req), req.user!.sub) });
}

export async function approveCardHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await approveCard(id(req), req.user!.sub) });
}

export async function rejectCardHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await rejectCard(id(req)) });
}

export async function archiveCardHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await archiveCard(id(req)) });
}

export async function reviseCardHandler(req: Request, res: Response): Promise<void> {
  res.status(201).json({ success: true, data: await reviseCard(id(req)) });
}

export async function quoteHandler(req: Request, res: Response): Promise<void> {
  const body = parse(quoteSchema, req.body);
  res.json({ success: true, data: await quoteFromCard(body) });
}

/**
 * Lot E: the one-word answer beside the verdict, for a badge. E11-1: the floor,
 * the shortfall and the case standing on the listing, for the party's screen —
 * the same shape whoever asks.
 */
export async function gateHandler(req: Request, res: Response): Promise<void> {
  const listingId = id(req, 'listingId');
  await assertMayAskGate(listingId, gateActor(req));
  res.json({ success: true, data: await gateView(listingId) });
}

/** E11 verify: the caller as the gate policy sees them — ADX, or one user id to match against the listing's publisher. */
const gateActor = (req: Request) => ({ userId: req.user!.sub, isAdmin: (req.user?.roles ?? []).includes('ADMIN') });

const impactShape = ({ card, rows }: Awaited<ReturnType<typeof cardImpact>>) => ({
  cardId: card.id,
  name: card.name,
  version: card.version,
  status: card.status,
  graceDays: card.graceDays,
  affected: rows.length,
  rows,
});

/** Lot E (Q97): what approving this card would do — or, once ACTIVE, did. */
export async function impactHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: impactShape(await cardImpact(id(req))) });
}

/** E10-2: the same shape over a draft grid, persisted nowhere. */
export async function impactDryRunHandler(req: Request, res: Response): Promise<void> {
  const body = parse(impactDryRunSchema, req.body);
  res.json({ success: true, data: impactShape(await cardImpactDryRun(id(req), body)) });
}

/**
 * E10-2: `?status=&source=&listingId=`; with `?page=` or `?pageSize=` the
 * list contract, otherwise the bare array it always answered, one release.
 */
export async function listApprovalsHandler(req: Request, res: Response): Promise<void> {
  const { page, pageSize, ...filter } = parse(approvalListQuerySchema, req.query);
  if (page !== undefined || pageSize !== undefined) {
    res.json({ success: true, data: await listApprovalsPage(filter, { page: page ?? 1, pageSize: pageSize ?? 20 }) });
    return;
  }
  res.json({ success: true, data: await listApprovals(filter) });
}

export async function requestApprovalHandler(req: Request, res: Response): Promise<void> {
  const body = parse(requestApprovalSchema, req.body);
  await assertMayAskGate(body.listingId, gateActor(req));
  res.status(201).json({
    success: true,
    data: await requestApproval(body.listingId, req.user!.sub, body.reason),
  });
}

export async function decideApprovalHandler(req: Request, res: Response): Promise<void> {
  const body = parse(decideApprovalSchema, req.body);
  res.json({
    success: true,
    data: await decideApproval(id(req), body.approve, req.user!.sub, body.note),
  });
}
