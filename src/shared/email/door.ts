import { getEffectiveEmailConfig, getEffectiveResendConfig, type EmailConfig } from '../integrations/integration-config';
import { sendMail } from './mail';
import { sendViaResend } from './resend';

/**
 * AE-B: the one door every outbound email leaves by.
 *
 * `primary` (Lot E, Q87) picks SMTP or Resend; on the SMTP door `mode`
 * picks the real host or the Ethereal test inbox. The dispatcher
 * (`notifications`), the password-reset link and the integrations test
 * route all call this — nothing calls `sendMail` or `sendViaResend`
 * directly any more, so a mode switch on the screen moves everything.
 * An unconfigured door still "sends" (the helper logs the message, which is
 * how a developer reads an invite link locally) and says `configured: false`.
 */
export type EmailProvider = 'SMTP' | 'RESEND' | 'ETHEREAL';

export interface EmailSendResult {
  provider: EmailProvider;
  configured: boolean;
  messageId: string | null;
  response: string | null;
  /** Where an Ethereal message can be read; null on a real door. */
  previewUrl: string | null;
}

/** Which door a config in force sends by — Resend when the primary says so, else the SMTP door in its mode. */
export function resolveEmailProvider(cfg: Pick<EmailConfig, 'primary' | 'mode'>): EmailProvider {
  if (cfg.primary === 'RESEND') return 'RESEND';
  return cfg.mode === 'ETHEREAL' ? 'ETHEREAL' : 'SMTP';
}

export async function sendEmail(to: string, subject: string, html: string): Promise<EmailSendResult> {
  const cfg = await getEffectiveEmailConfig();
  const provider = resolveEmailProvider(cfg);

  if (provider === 'RESEND') {
    const { apiKey } = await getEffectiveResendConfig();
    const receipt = await sendViaResend(to, subject, html);
    return {
      provider,
      configured: Boolean(apiKey),
      messageId: receipt?.messageId ?? null,
      response: receipt?.response ?? null,
      previewUrl: null,
    };
  }

  const receipt = await sendMail(to, subject, html);
  return {
    provider,
    // Ethereal needs no credentials: it is always configured.
    configured: provider === 'ETHEREAL' || Boolean(cfg.host),
    messageId: receipt?.messageId ?? null,
    response: receipt?.response ?? null,
    previewUrl: receipt?.previewUrl ?? null,
  };
}
