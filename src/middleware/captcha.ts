import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { ApiError } from '../lib/errors';
import { logger } from '../lib/logger';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Verifies the Cloudflare Turnstile token the frontend widget attaches as
// `captchaToken`. No-ops when TURNSTILE_SECRET_KEY isn't configured — same
// graceful-degrade pattern as sms.service.ts/mail.service.ts — so local dev
// works without a live site key.
export async function verifyCaptcha(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY) {
    next();
    return;
  }

  const token = req.body?.captchaToken;
  if (!token || typeof token !== 'string') {
    next(new ApiError(400, 'VALIDATION_ERROR', 'Captcha verification is required'));
    return;
  }

  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: req.ip,
      }),
    });

    const result = (await response.json()) as { success: boolean; 'error-codes'?: string[] };

    if (!result.success) {
      logger.warn('Turnstile verification failed', { errorCodes: result['error-codes'] });
      next(new ApiError(403, 'FORBIDDEN', 'Captcha verification failed. Please try again.'));
      return;
    }

    next();
  } catch (err) {
    logger.error('Turnstile verification request failed', { err });
    next(new ApiError(503, 'INTERNAL_ERROR', 'Captcha verification is temporarily unavailable'));
  }
}
