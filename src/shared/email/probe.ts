import { getEffectiveEmailConfig, getEffectiveResendConfig } from '../integrations/integration-config';
import { resolveEmailProvider, sendEmail, type EmailProvider } from './door';

/**
 * AE-B: the test behind `POST /integrations/email/test` — one message
 * through the one door, and a plain verdict the card prints.
 *
 * Never a throw for anything the vendor did: a missing host or key, a
 * refused login (bad Gmail app password), a Resend 4xx and a door that does
 * not answer in 15 s are all verdicts with `ok: false` and a sentence. The
 * SMTP password and the Resend key are masked out of every sentence and
 * response line before they leave, in case a vendor echoed one.
 */
export const EMAIL_TEST_TIMEOUT_MS = 15_000;
export const EMAIL_TEST_SUBJECT = 'ADX test message';
export const EMAIL_UNCONFIGURED_SMTP = 'SMTP is not configured - fill the host, or switch the mode to Ethereal for a test inbox.';
export const EMAIL_UNCONFIGURED_RESEND = 'Resend is not configured - paste the API key, or switch the primary door to SMTP.';
export const EMAIL_TEST_TIMED_OUT = 'The door did not answer in time';
const RESPONSE_MAX = 500;

export interface EmailDoorVerdict {
  provider: EmailProvider;
  configured: boolean;
  ok: boolean;
  messageId: string | null;
  previewUrl: string | null;
  /** The vendor's response line, secrets masked, cut to 500 characters. */
  response: string | null;
  message: string;
}

class DoorTimeout extends Error {
  constructor() {
    super(EMAIL_TEST_TIMED_OUT);
    this.name = 'DoorTimeout';
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DoorTimeout()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Every occurrence of a secret becomes the mask; the text is cut to what a card prints. */
export function maskSecretsIn(text: string | null | undefined, secrets: ReadonlyArray<string | undefined>): string | null {
  if (!text) return null;
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) out = out.split(secret).join('••••');
  }
  return out.slice(0, RESPONSE_MAX);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DOOR_NAMES: Record<EmailProvider, string> = {
  SMTP: 'SMTP',
  RESEND: 'Resend',
  ETHEREAL: 'the Ethereal test inbox',
};

/** The message the test sends: short, naming the door, the from address and the time. */
export function testEmailMessage(provider: EmailProvider, from: string | undefined, now: Date): { subject: string; html: string } {
  return {
    subject: EMAIL_TEST_SUBJECT,
    html: [
      '<p>This is the ADX test email.</p>',
      `<p>Door: ${escapeHtml(DOOR_NAMES[provider])}<br/>`,
      `From: ${escapeHtml(from ?? '(no from address)')}<br/>`,
      `Sent at: ${now.toISOString()}</p>`,
      '<p>If you can read this, the door is open.</p>',
    ].join(''),
  };
}

export async function testEmailDoor(to: string, now = new Date()): Promise<EmailDoorVerdict> {
  const email = await getEffectiveEmailConfig();
  const resend = await getEffectiveResendConfig();
  const provider = resolveEmailProvider(email);
  const secrets = [email.password, resend.apiKey];
  const unconfigured = (message: string): EmailDoorVerdict => ({
    provider,
    configured: false,
    ok: false,
    messageId: null,
    previewUrl: null,
    response: null,
    message,
  });

  if (provider === 'SMTP' && !email.host) return unconfigured(EMAIL_UNCONFIGURED_SMTP);
  if (provider === 'RESEND' && !resend.apiKey) return unconfigured(EMAIL_UNCONFIGURED_RESEND);

  const from = provider === 'RESEND' ? resend.fromEmail : email.from;
  const { subject, html } = testEmailMessage(provider, from, now);

  try {
    const result = await withTimeout(sendEmail(to, subject, html), EMAIL_TEST_TIMEOUT_MS);
    const message =
      result.provider === 'ETHEREAL'
        ? 'Sent to the Ethereal test inbox - nothing was delivered; open the preview link to read it.'
        : result.provider === 'RESEND'
          ? `Sent via Resend from ${from ?? '(no from address)'}.`
          : `Sent via SMTP (${email.host}:${email.port ?? 'default port'}) from ${from ?? '(no from address)'}.`;
    return {
      provider: result.provider,
      configured: result.configured,
      ok: result.configured,
      messageId: result.messageId,
      previewUrl: result.previewUrl,
      response: maskSecretsIn(result.response, secrets),
      message,
    };
  } catch (err) {
    const sentence = err instanceof DoorTimeout ? EMAIL_TEST_TIMED_OUT : (maskSecretsIn(err instanceof Error ? err.message : String(err), secrets) ?? 'The door refused the message.');
    return {
      provider,
      configured: true,
      ok: false,
      messageId: null,
      previewUrl: null,
      response: null,
      message: sentence,
    };
  }
}
