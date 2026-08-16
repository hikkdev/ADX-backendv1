import { logger } from '../lib/logger';
import { getEffectiveResendConfig } from './integrationConfig.service';

/**
 * Sends an email via the Resend API whenever Resend is configured (dev or
 * production alike). Logs the message to the console instead if unconfigured.
 */
export async function sendViaResend(to: string, subject: string, html: string): Promise<void> {
  const { apiKey, fromEmail } = await getEffectiveResendConfig();

  if (!apiKey) {
    logger.info(`[RESEND UNCONFIGURED] -> ${to}: ${subject}\n${html}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to,
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error('Resend send failed', { to, status: response.status, body: err });
    throw new Error(`Email delivery failed: ${response.status}`);
  }

  logger.info('Email sent via Resend', { to, subject });
}
