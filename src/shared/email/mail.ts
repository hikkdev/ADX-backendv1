import nodemailer from 'nodemailer';
import { logger } from '../logging/logger';
import { getEffectiveEmailConfig } from '../integrations/integration-config';

/**
 * Sends an email via SMTP whenever SMTP is configured (dev or production
 * alike). Logs the message to the console instead if unconfigured.
 */
export async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const { host, port, user, password, from } = await getEffectiveEmailConfig();

  if (!host) {
    logger.info(`[MAIL UNCONFIGURED] -> ${to}: ${subject}\n${html}`);
    return;
  }

  // A fresh transporter per send — config can change live via the admin
  // panel, and nodemailer transporter creation is cheap at this volume.
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass: password } : undefined,
  });

  await transporter.sendMail({ from, to, subject, html });

  logger.info('Email sent', { to, subject });
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
