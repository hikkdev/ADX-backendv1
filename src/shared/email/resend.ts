import { logger } from '../logging/logger';
import { getEffectiveResendConfig } from '../integrations/integration-config';
import type { MailSendReceipt } from './mail';

/** Resend answers `{ statusCode, name, message }`; the message is the sentence worth printing. */
function resendSentence(body: string): string {
  try {
    const data = JSON.parse(body) as { message?: unknown };
    return typeof data.message === 'string' && data.message ? ` — ${data.message}` : '';
  } catch {
    return '';
  }
}

/**
 * Sends an email via the Resend API whenever Resend is configured (dev or
 * production alike). Logs the message to the console instead if unconfigured.
 */
export async function sendViaResend(to: string, subject: string, html: string): Promise<MailSendReceipt> {
  const { apiKey, fromEmail } = await getEffectiveResendConfig();

  if (!apiKey) {
    logger.info(`[RESEND UNCONFIGURED] -> ${to}: ${subject}\n${html}`);
    return { messageId: null, response: null };
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
    // AE-B: Resend's own sentence rides along so the test verdict can print
    // it; the status stays first so a caller matching on it still does.
    throw new Error(`Email delivery failed: ${response.status}${resendSentence(err)}`);
  }

  // Lot G (Q121): the id Resend minted, and its answer as it came, for the attempt row.
  const text = await response.text().catch(() => '');
  let messageId: string | null = null;
  try {
    const data = JSON.parse(text) as { id?: unknown };
    messageId = typeof data.id === 'string' ? data.id : null;
  } catch {
    /* not JSON: the raw text is still the response */
  }
  logger.info('Email sent via Resend', { to, subject });
  return { messageId, response: text || null };
}
