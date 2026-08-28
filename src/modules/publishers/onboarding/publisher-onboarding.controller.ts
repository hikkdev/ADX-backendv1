import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { env } from '../../../config/env';
import { registerPublisherSchema } from '../publishers.schema';
import {
  cancelMyOnboarding,
  cancelOnboarding,
  completeOnboarding,
  getMyProfile,
  getOrCreateOnboardingQr,
  registerProfile,
} from './publisher-onboarding.service';

// POST /publishers/register — called after OTP verified, creates publisher profile
export async function registerPublisherProfileHandler(req: Request, res: Response): Promise<void> {
  const parsed = registerPublisherSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { publisher, created } = await registerProfile(
    req.user!.sub,
    parsed.data.name,
    parsed.data.email,
  );

  // 201 on first registration, 200 when an existing profile is returned.
  res.status(created ? 201 : 200).json({ success: true, data: publisher });
}

export async function getMyPublisherProfileHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyProfile(req.user!.sub) });
}

// GET /publishers/me/qr — generate or return the existing active onboarding QR
export async function getMyOnboardingQrHandler(req: Request, res: Response): Promise<void> {
  const { qrId, token, created } = await getOrCreateOnboardingQr(req.user!.sub);

  const base = env.BASE_URL ?? '';
  // 201 only when a new code was minted; reusing an existing one answers 200.
  res.status(created ? 201 : 200).json({
    success: true,
    data: { qrId, token, pngUrl: `${base}/api/v1/qr/${qrId}/image.png` },
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
  await completeOnboarding(
    req.params['publisherId'] as string,
    req.user!.sub,
    (req.user?.roles ?? []).includes('ADMIN'),
  );
  res.json({
    success: true,
    data: { message: 'Onboarding complete. Publisher dashboard is now unlocked.' },
  });
}
