import fs from 'fs';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { reportError } from '../../../shared/errors';
import { getEffectiveSecureIdConfig } from '../../../shared/integrations';
import { parseSecureIdEvent, verificationRuntime, verifySecureIdWebhook, type ImageInput } from '../../../shared/verification';
import {
  SELFIE_MAX_BYTES,
  SELFIE_MIME_TYPES,
  bankStepSchema,
  businessStepSchema,
  caseSchema,
  digilockerStartSchema,
  drivingLicenceStepSchema,
  vehicleStepSchema,
} from './verification.schema';
import {
  getSession,
  listMySessions,
  listCaseAttempts,
  processSecureIdEvent,
  refreshDigilocker,
  resendOnBackup,
  startDigilocker,
  submitBank,
  submitBusiness,
  submitDrivingLicence,
  submitSelfie,
  submitVehicle,
  verificationHealth,
} from './verification.service';

const sessionId = (req: Request) => req.params['id'] as string;

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    // The schema's sentences are written for the person; the first one is the message, the rest stay in the details.
    const flat = parsed.error.flatten() as { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> };
    const first = Object.values(flat.fieldErrors).flat().find(Boolean) ?? flat.formErrors[0];
    throw new ApiError(400, 'VALIDATION_ERROR', first ?? 'Invalid request', flat);
  }
  return parsed.data;
}

/* ── the person's own session ──────────────────────────────────── */

// GET /verification/sessions/:id
// GET /verification/sessions/mine → { sessions }
export async function listMySessionsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listMySessions(req.user!.sub) });
}

export async function getSessionHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getSession(sessionId(req), req.user!.sub) });
}

// POST /verification/sessions/:id/digilocker { redirectUrl } → { url, expiresAt, session }
export async function startDigilockerHandler(req: Request, res: Response): Promise<void> {
  const body = parse(digilockerStartSchema, req.body);
  res.json({ success: true, data: await startDigilocker(sessionId(req), req.user!.sub, body) });
}

// POST /verification/sessions/:id/digilocker/refresh → { status, failureCode, name, documents, session }
export async function refreshDigilockerHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await refreshDigilocker(sessionId(req), req.user!.sub) });
}

/**
 * POST /verification/sessions/:id/selfie — multipart, field `file`.
 *
 * The picture comes in through the one multipart door ADX has (the upload
 * intake's middleware, which writes it to a temp file) and goes no further:
 * it is read into memory, the temp file is deleted before anything else
 * happens, and nothing is stored — not on the attempt, not as a file. Only
 * the scores stay (E-bis, 2 Oct 2026).
 */
export async function submitSelfieHandler(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file) throw new ApiError(400, 'NO_FILE', 'Send the selfie as a file in the field "file".');
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(file.path);
  } finally {
    await fs.promises.unlink(file.path).catch(() => undefined);
  }
  const mime = file.mimetype.toLowerCase();
  if (!(SELFIE_MIME_TYPES as readonly string[]).includes(mime)) throw new ApiError(400, 'INVALID_IMAGE', 'The selfie must be a JPEG or a PNG picture.');
  if (bytes.length === 0 || bytes.length > SELFIE_MAX_BYTES) throw new ApiError(400, 'FILE_TOO_LARGE', 'The selfie must be 5 MB or smaller.');
  const image: ImageInput = { bytes, mime: mime as ImageInput['mime'] };
  res.json({ success: true, data: await submitSelfie(sessionId(req), req.user!.sub, image) });
}

// POST /verification/sessions/:id/bank { accountNumber, ifsc } → { bank, nameMatch, session }
export async function submitBankHandler(req: Request, res: Response): Promise<void> {
  const body = parse(bankStepSchema, req.body);
  res.json({ success: true, data: await submitBank(sessionId(req), req.user!.sub, body) });
}

// POST /verification/sessions/:id/business { pan, gstin? } → { pan, gstin, session }
export async function submitBusinessHandler(req: Request, res: Response): Promise<void> {
  const body = parse(businessStepSchema, req.body);
  res.json({ success: true, data: await submitBusiness(sessionId(req), req.user!.sub, body) });
}

// POST /verification/sessions/:id/driving-licence { dlNumber, dob } → { drivingLicence, session }
export async function submitDrivingLicenceHandler(req: Request, res: Response): Promise<void> {
  const body = parse(drivingLicenceStepSchema, req.body);
  res.json({ success: true, data: await submitDrivingLicence(sessionId(req), req.user!.sub, body) });
}

// POST /verification/sessions/:id/vehicle { vehicleNumber } → { vehicle, session }
export async function submitVehicleHandler(req: Request, res: Response): Promise<void> {
  const body = parse(vehicleStepSchema, req.body);
  res.json({ success: true, data: await submitVehicle(sessionId(req), req.user!.sub, body) });
}

/* ── the desk ──────────────────────────────────────────────────── */

// GET /verification/attempts?caseType=&caseId=
export async function listAttemptsHandler(req: Request, res: Response): Promise<void> {
  const query = parse(caseSchema, req.query);
  res.json({ success: true, data: await listCaseAttempts(query.caseType, query.caseId) });
}

// POST /verification/cases/:caseType/:caseId/resend-on-backup
export async function resendOnBackupHandler(req: Request, res: Response): Promise<void> {
  const target = parse(caseSchema, { caseType: req.params['caseType'], caseId: req.params['caseId'] });
  res.json({ success: true, data: await resendOnBackup(target.caseType, target.caseId, req.user!.sub, req) });
}

// GET /verification/health
export async function verificationHealthHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await verificationHealth() });
}

/* ── Cashfree's webhook ────────────────────────────────────────── */

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
};

/** Events being worked on after their 200 went out — awaited by the tests, never by a request. */
const inFlight = new Set<Promise<unknown>>();
export async function secureIdWebhookSettled(): Promise<void> {
  await Promise.all([...inFlight]);
}

/**
 * POST /webhooks/cashfree/verification — called by Cashfree Secure ID,
 * authenticated by HMAC over the RAW body with the Secure ID client secret.
 *
 * The rules, in the order they are applied:
 *
 * 1. A caller who cannot prove they are Cashfree gets **401** — including
 *    when no secret is on file, and including a correctly signed call whose
 *    timestamp is more than five minutes off (a replay).
 * 2. A verified call whose body is not an event ADX understands still gets
 *    **200**: Cashfree retries on error, and a body that will never be
 *    accepted must not become a retry loop.
 * 3. An event already seen (`ProviderEvent`, unique on the provider and the
 *    event) gets **200** and is not worked on twice.
 * 4. A new event is answered **200 at once** and worked on after the
 *    response has gone — fetching the DigiLocker documents takes two more
 *    calls to Cashfree, and Cashfree should not be kept waiting on them.
 */
export async function secureIdWebhookHandler(req: Request, res: Response): Promise<void> {
  const keys = await getEffectiveSecureIdConfig();
  const verdict = verifySecureIdWebhook({
    rawBody: req.rawBody,
    signature: header(req, 'x-webhook-signature'),
    timestamp: header(req, 'x-webhook-timestamp'),
    secret: keys.clientSecret,
  });
  if (!verdict.ok) {
    logger.error('Cashfree verification webhook rejected', { reason: verdict.reason });
    throw new ApiError(401, 'UNAUTHORIZED', verdict.reason === 'STALE' ? 'The webhook timestamp is too old' : 'The webhook signature could not be verified');
  }

  const event = parseSecureIdEvent(req.body);
  if (!event) {
    logger.warn('Cashfree verification webhook: signature valid but the body is not an event');
    res.json({ success: true });
    return;
  }

  const events = verificationRuntime().events;
  const claim = await events.claim('CASHFREE_SECURE_ID', event.eventId, event.eventType);
  res.json({ success: true });
  if (!claim.fresh || !claim.id) return;

  const claimId = claim.id;
  const work = processSecureIdEvent(event)
    .then((outcome) => events.finish(claimId, outcome))
    .catch(async (err: unknown) => {
      logger.error('Cashfree verification webhook could not be applied', { eventType: event.eventType, reason: err instanceof Error ? err.name : 'unknown' });
      void reportError(err, { tag: 'secureIdWebhook' });
      await events.finish(claimId, 'ERROR').catch(() => undefined);
    })
    .finally(() => inFlight.delete(work));
  inFlight.add(work);
}
