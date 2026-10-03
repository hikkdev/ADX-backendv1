import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../shared/errors';
import { env } from '../../../config';
import { logger } from '../../../shared/logging';
import { signatureFailureMessage, verifyHmacSignature } from '../../../shared/security';
import { kycStartBodySchema, type KycStartBody } from '../../../shared/kyc-state';
import { assertOwnedPublisher } from '../publishers.service';
import {
  getDigioKycStatus,
  handleDigioWebhook,
  initiateDigioKyc,
  type DigioWebhookPayload,
} from './digio.service';

// POST /publishers/:publisherId/kyc/digio/initiate — body `{ entityType? }` (Phase D)
export async function initiateDigioKycHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  const body = parseKycStartBody(req.body);
  const publisher = await assertOwnedPublisher(publisherId, req.user!.sub);

  const result = await initiateDigioKyc(publisher, { byUserId: req.user!.sub, entityType: body.entityType, req });

  res.json({ success: true, data: result });
}

/** Phase D: `{ entityType? }` on a Digio start — an unknown value is 400 before anything is looked up. */
export function parseKycStartBody(body: unknown): KycStartBody {
  const parsed = kycStartBodySchema.safeParse(body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  return parsed.data;
}

// GET /publishers/:publisherId/kyc/digio/status
export async function getDigioKycStatusHandler(req: Request, res: Response): Promise<void> {
  const publisherId = req.params['publisherId'] as string;
  await assertOwnedPublisher(publisherId, req.user!.sub);

  const status = await getDigioKycStatus(publisherId);
  if (!status) throw new ApiError(404, 'NOT_FOUND', 'No KYC record found');
  res.json({ success: true, data: status });
}

/**
 * Phase D (1 Oct 2026): the statuses are taken as Digio sends them — a
 * workflow may answer `approval_pending` or `requested` where the first
 * request only ever said approved / rejected / pending / cancelled. Kept raw
 * on `digioStatus`; `digioDecisionOf` reads anything but approved and
 * rejected as PENDING. Dropping them as unparseable lost the callback.
 */
const DIGIO_STATUS = z.string().trim().min(1).max(64);

const webhookSchema = z.object({
  id: z.string(),
  customer_identifier: z.string().optional(),
  status: DIGIO_STATUS,
  message: z.string().optional(),
  kyc_documents: z
    .array(
      z.object({
        type: z.string(),
        status: DIGIO_STATUS,
        name: z.string().optional(),
        dob: z.string().optional(),
        id_number: z.string().optional(),
      }),
    )
    .optional(),
  completed_at: z.string().optional(),
});

/**
 * Header Digio signs the raw body with.
 *
 * Configurable in name only through this constant rather than the environment,
 * because a provider changing its header is a code change with a test, not an
 * operations toggle that can be got wrong silently.
 */
const SIGNATURE_HEADER = 'x-digio-signature';

/**
 * POST /webhooks/digio — called by Digio, authenticated by HMAC.
 *
 * This handler moves a publisher to VERIFIED, and that is precisely what
 * unlocks payouts. Unauthenticated, it let anyone holding or guessing a Digio
 * request id verify a publisher and start drawing money — the id is the only
 * thing the old version checked, and it is not a secret.
 *
 * Two rules, and they pull in opposite directions:
 *
 * 1. A caller who cannot prove they are Digio gets **401**, including when the
 *    secret is unset. A verifier that waves everything through when
 *    unconfigured is worse than none: it reads as protection and provides none,
 *    and the day someone deploys without the variable is the day it silently
 *    reverts to the hole it replaced.
 *
 * 2. A *verified* caller whose payload we cannot parse still gets **200**.
 *    Digio retries on error, so answering 4xx to a body we will never accept
 *    turns one malformed callback into an indefinite retry loop.
 *
 * The signature check therefore comes first and fails loudly; parsing comes
 * second and fails quietly.
 */
export async function digioWebhookHandler(req: Request, res: Response): Promise<void> {
  const header = req.headers[SIGNATURE_HEADER];
  const verdict = verifyHmacSignature({
    rawBody: req.rawBody,
    signature: typeof header === 'string' ? header : undefined,
    secret: env.DIGIO_WEBHOOK_SECRET,
  });

  if (!verdict.ok) {
    // Logged at error rather than warn: an unconfigured secret is an outage of
    // the KYC pipeline, and a mismatch is somebody trying it on. Both want
    // somebody looking.
    logger.error('Digio webhook rejected', { reason: verdict.reason });
    throw new ApiError(401, 'UNAUTHORIZED', signatureFailureMessage[verdict.reason]);
  }

  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('Digio webhook: signature valid but payload unrecognised');
    res.json({ success: true });
    return;
  }
  await handleDigioWebhook(parsed.data as DigioWebhookPayload);
  res.json({ success: true });
}
