import type { Request, Response } from 'express';
import { env } from '../../../config/env';
import { hasPermission } from '../../../shared/auth';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { pageQueryFrom } from '../../../shared/pagination';
import { signatureFailureMessage, verifyHmacSignature } from '../../../shared/security';
import { openSigningSchema, signingFilterSchema, voidSigningSchema } from './esign.schema';
import {
  findSigningRequest,
  handleEsignWebhook,
  listSigningRequests,
  mayActOn,
  mockSign,
  mySigningRequests,
  openSigningRequest,
  refreshSigningRequest,
  remindSigning,
  signingView,
  voidSigning,
} from './esign.service';

/**
 * DS-1: the signing routes. The desk's list, send, remind and void under
 * ADMIN; the party's own reads (`/mine`, `/:id`, `/:id/refresh`) for any
 * signed-in person who belongs to the request's party; the mock signature
 * as the development door; the webhook without a session at all.
 */

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error?.flatten());
  return result.data as T;
}

const actor = (req: Request): string => {
  const sub = req.user?.sub;
  if (!sub) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in to continue');
  return sub;
};

const isAdmin = (req: Request): boolean => (req.user?.roles ?? []).includes('ADMIN') || hasPermission(req.user, 'settings.view');

async function requireActable(req: Request) {
  const row = await findSigningRequest(req.params['id'] as string);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Signing request not found');
  if (!(await mayActOn(actor(req), row, isAdmin(req)))) throw new ApiError(403, 'FORBIDDEN', 'This signing request is not yours');
  return row;
}

/* The desk ---------------------------------------------------------- */

export async function listSigningHandler(req: Request, res: Response): Promise<void> {
  const filter = parse(signingFilterSchema, req.query);
  res.json({ success: true, data: await listSigningRequests(filter, pageQueryFrom(req.query as Record<string, unknown>)) });
}

export async function openSigningHandler(req: Request, res: Response): Promise<void> {
  const body = parse(openSigningSchema, req.body);
  const { request, created } = await openSigningRequest({
    kind: body.kind,
    partyType: body.partyType,
    partyId: body.partyId,
    requestedById: actor(req),
    ...(body.campaignId ? { anchor: { campaignId: body.campaignId } } : {}),
    force: body.force ?? true,
  });
  res.status(created ? 201 : 200).json({ success: true, data: { ...signingView(request), created } });
}

export async function remindSigningHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: signingView(await remindSigning(req.params['id'] as string, actor(req))) });
}

export async function voidSigningHandler(req: Request, res: Response): Promise<void> {
  const body = parse(voidSigningSchema, req.body);
  res.json({ success: true, data: signingView(await voidSigning(req.params['id'] as string, body.reason, actor(req))) });
}

/* The party --------------------------------------------------------- */

export async function mySigningHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await mySigningRequests(actor(req)) });
}

export async function getSigningHandler(req: Request, res: Response): Promise<void> {
  const row = await requireActable(req);
  res.json({ success: true, data: signingView(row) });
}

export async function refreshSigningHandler(req: Request, res: Response): Promise<void> {
  const row = await requireActable(req);
  res.json({ success: true, data: signingView(await refreshSigningRequest(row.id)) });
}

/** The development door: signs a mocked request as the caller. */
export async function mockSignHandler(req: Request, res: Response): Promise<void> {
  const row = await requireActable(req);
  res.json({ success: true, data: signingView(await mockSign(row.id, actor(req))) });
}

/* The provider ------------------------------------------------------ */

/** The header Digio signs its webhooks under — the same as the KYC callback's. */
const SIGNATURE_HEADER = 'x-digio-signature';

/**
 * `POST /webhooks/digio/esign` — signature-checked over the raw body with
 * the same secret as the KYC hook, and failing closed the same way: an
 * unsigned call could mark a contract signed.
 */
export async function esignWebhookHandler(req: Request, res: Response): Promise<void> {
  const header = req.headers[SIGNATURE_HEADER];
  const verdict = verifyHmacSignature({ rawBody: req.rawBody, signature: typeof header === 'string' ? header : undefined, secret: env.DIGIO_WEBHOOK_SECRET });
  if (!verdict.ok) {
    logger.error('Digio eSign webhook rejected', { reason: verdict.reason });
    throw new ApiError(401, 'UNAUTHORIZED', signatureFailureMessage[verdict.reason]);
  }
  const result = await handleEsignWebhook(req.body);
  res.json({ success: true, ...result });
}
