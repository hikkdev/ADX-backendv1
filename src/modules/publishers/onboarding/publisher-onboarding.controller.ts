import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { env } from '../../../config/env';
import { qrErrorToApi } from '../../qr';
import { registerPublisherSchema, submitKycSchema, updateMyProfileSchema } from '../publishers.schema';
import {
  cancelMyOnboarding,
  cancelOnboarding,
  completeMyOnboarding,
  completeOnboarding,
  decideMyOnboardingScan,
  getMyKyc,
  getOnboardingQrStatus,
  getMyProfile,
  getOrCreateOnboardingQr,
  registerProfile,
  submitMyKyc,
  updateMyProfile,
  initiateMyDigioKyc,
  myDigioKycStatus,
  getMyAccessLog,
} from './publisher-onboarding.service';

// POST /publishers/register — called after OTP verified, creates publisher profile
export async function registerPublisherProfileHandler(req: Request, res: Response): Promise<void> {
  const parsed = registerPublisherSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { publisher, created } = await registerProfile(req.user!.sub, {
    name: parsed.data.name,
    email: parsed.data.email,
  });

  // 201 on first registration, 200 when an existing profile is returned.
  res.status(created ? 201 : 200).json({ success: true, data: publisher });
}

export async function getMyPublisherProfileHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyProfile(req.user!.sub) });
}

// GET /publishers/me/qr — generate or return the existing active onboarding QR
export async function getMyOnboardingQrHandler(req: Request, res: Response): Promise<void> {
  // The phone's fix, when it has one, so the scan can be measured against it.
  const latitude = Number(req.query['latitude']);
  const longitude = Number(req.query['longitude']);
  const position =
    Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : undefined;
  const { qrId, token, expiresAt, created } = await getOrCreateOnboardingQr(req.user!.sub, position);

  const base = env.BASE_URL ?? '';
  // 201 only when a new code was minted; reusing a live one answers 200.
  res.status(created ? 201 : 200).json({
    success: true,
    data: { qrId, token, expiresAt, pngUrl: `${base}/api/v1/qr/${qrId}/image.png` },
  });
}

export async function cancelMyOnboardingHandler(req: Request, res: Response): Promise<void> {
  await cancelMyOnboarding(req.user!.sub);
  res.json({
    success: true,
    data: { message: 'Onboarding cancelled. You can generate a new QR.' },
  });
}

export async function cancelOnboardingHandler(req: Request, res: Response): Promise<void> {
  await cancelOnboarding(req.params['publisherId'] as string);
  res.json({ success: true, data: { message: 'Onboarding cancelled.' } });
}

export async function completeOnboardingHandler(req: Request, res: Response): Promise<void> {
  const { incentive } = await completeOnboarding(
    req.params['publisherId'] as string,
    req.user!.sub,
    (req.user?.roles ?? []).includes('ADMIN'),
  );
  res.json({
    success: true,
    // Lot B (Q101): the commission the app prints on the completion screen, or null.
    data: { message: 'Onboarding complete. Publisher dashboard is now unlocked.', incentive },
  });
}

// ── Self-service, DR 08 ─────────────────────────────────────────────────────

// PATCH /publishers/me — Steps 2–4
export async function updateMyPublisherProfileHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateMyProfileSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await updateMyProfile(req.user!.sub, parsed.data) });
}

// GET /publishers/me/kyc — null before the first submission
export async function getMyKycHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyKyc(req.user!.sub) });
}

// POST /publishers/me/kyc — Steps 6–11, in the publisher's own hands
export async function submitMyKycHandler(req: Request, res: Response): Promise<void> {
  const parsed = submitKycSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.status(201).json({ success: true, data: await submitMyKyc(req.user!.sub, parsed.data) });
}

// POST /publishers/me/complete-onboarding — the end of a self-run ladder
export async function completeMyOnboardingHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await completeMyOnboarding(req.user!.sub) });
}

// GET /publishers/me/qr/status — polled while the code is on screen
export async function getMyOnboardingQrStatusHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getOnboardingQrStatus(req.user!.sub) });
}

// POST /publishers/me/qr/scans/:scanId/approve|decline — the owner's decision
export async function decideMyOnboardingScanHandler(req: Request, res: Response): Promise<void> {
  const decision = req.path.endsWith('/approve') ? 'approve' : 'decline';
  try {
    res.json({
      success: true,
      data: await decideMyOnboardingScan(req.user!.sub, req.params['scanId'] as string, decision),
    });
  } catch (err) {
    qrErrorToApi(err);
  }
}

/* ── U7 / U9: Digio in the publisher's own hands, and their access log ──────── */

export async function initiateMyDigioKycHandler(req: Request, res: Response): Promise<void> {
  res.status(201).json({ success: true, data: await initiateMyDigioKyc(req.user!.sub) });
}

export async function getMyDigioKycStatusHandler(req: Request, res: Response): Promise<void> {
  const status = await myDigioKycStatus(req.user!.sub);
  if (!status) throw new ApiError(404, 'NOT_FOUND', 'No KYC record found');
  res.json({ success: true, data: status });
}

export async function getMyAccessLogHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyAccessLog(req.user!.sub) });
}
