import nodemailer from 'nodemailer';
import { logger } from '../logging/logger';
import { getEffectiveEmailConfig } from '../integrations/integration-config';
import { getEtherealAccount } from './ethereal';

/**
 * Lot G (Q121): what the door answered, for the delivery log's attempt row —
 * the provider's message id and its raw response line. Both null when the
 * door is unconfigured and the message was only logged. AE-B: `previewUrl`
 * is where an Ethereal message can be read; null on a real host.
 */
export interface MailSendReceipt {
  messageId: string | null;
  response: string | null;
  previewUrl?: string | null;
}

type SentInfo = { messageId?: string; response?: string } | undefined;

/**
 * Sends an email via SMTP whenever SMTP is configured (dev or production
 * alike). Logs the message to the console instead if unconfigured.
 *
 * AE-B: under `mode: 'ETHEREAL'` the host is not consulted — the message
 * goes to the Ethereal test inbox (`./ethereal.ts`), which never delivers,
 * and the receipt carries the preview URL. Prefer `sendEmail` (the one
 * door in `./door.ts`), which also honours `primary: 'RESEND'`.
 */
export async function sendMail(to: string, subject: string, html: string): Promise<MailSendReceipt> {
  const { host, port, user, password, from, mode } = await getEffectiveEmailConfig();

  if (mode === 'ETHEREAL') {
    const account = await getEtherealAccount();
    const transporter = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.user, pass: account.pass },
    });
    const info = await transporter.sendMail({ from, to, subject, html });
    const preview = nodemailer.getTestMessageUrl(info);
    const previewUrl = typeof preview === 'string' && preview ? preview : null;
    logger.info('Email sent to the Ethereal test inbox (not delivered)', { to, subject, previewUrl });
    return { messageId: info?.messageId ?? null, response: info?.response ?? null, previewUrl };
  }

  if (!host) {
    logger.info(`[MAIL UNCONFIGURED] -> ${to}: ${subject}
${html}`);
    return { messageId: null, response: null, previewUrl: null };
  }

  // A fresh transporter per send — config can change live via the admin
  // panel, and nodemailer transporter creation is cheap at this volume.
  // 465 is implicit TLS (`secure`), anything else (587) upgrades by STARTTLS.
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass: password } : undefined,
  });

  const info = (await transporter.sendMail({ from, to, subject, html })) as SentInfo;

  logger.info('Email sent', { to, subject });
  return { messageId: info?.messageId ?? null, response: info?.response ?? null, previewUrl: null };
}

export function passwordResetEmail(resetUrl: string): { subject: string; html: string } {
  return {
    subject: 'Reset your ADX Admin password',
    html: `
      <p>We received a request to reset your ADX Admin password.</p>
      <p><a href="${resetUrl}">Click here to reset your password</a>. This link expires in 30 minutes.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  };
}
