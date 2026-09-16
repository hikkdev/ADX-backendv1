import nodemailer from 'nodemailer';
import { redis } from '../cache/redis';
import { logger } from '../logging/logger';

/**
 * AE-B: the Ethereal test inbox — temporary testing with zero credentials.
 *
 * Ethereal (ethereal.email, run by the nodemailer authors) is a catch-all
 * SMTP host that NEVER delivers: every message it accepts is held in a
 * throwaway inbox and readable at a preview URL. `nodemailer.createTestAccount()`
 * mints such an inbox on demand; this module mints it ONCE and keeps it in
 * Redis for a day so the inbox stays the same across sends and instances —
 * a miss (or a Redis that is down) just mints a new one. The account's
 * password never leaves the server: the preview URL needs no login, and the
 * masked integrations read answers the login name alone.
 */
export const ETHEREAL_ACCOUNT_KEY = 'email:ethereal:account';
export const ETHEREAL_ACCOUNT_TTL_SECONDS = 24 * 60 * 60;
/** Where the inbox lives — informational; the preview URLs are how a message is read. */
export const ETHEREAL_WEB_URL = 'https://ethereal.email/login';

export interface EtherealAccount {
  user: string;
  pass: string;
  smtp: { host: string; port: number; secure: boolean };
}

function isAccount(value: unknown): value is EtherealAccount {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const smtp = v['smtp'] as Record<string, unknown> | undefined;
  return (
    typeof v['user'] === 'string' &&
    typeof v['pass'] === 'string' &&
    typeof smtp === 'object' &&
    smtp !== null &&
    typeof smtp['host'] === 'string' &&
    typeof smtp['port'] === 'number' &&
    typeof smtp['secure'] === 'boolean'
  );
}

/** The cached inbox, or null — never creates one (the read screen asks this). */
export async function readEtherealAccount(): Promise<EtherealAccount | null> {
  try {
    const raw = await redis.get(ETHEREAL_ACCOUNT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isAccount(parsed) ? parsed : null;
  } catch (err) {
    logger.warn('Ethereal account not read from Redis', { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The inbox to send through: the cached one, else a fresh one cached for a day. */
export async function getEtherealAccount(): Promise<EtherealAccount> {
  const cached = await readEtherealAccount();
  if (cached) return cached;

  const created = await nodemailer.createTestAccount();
  const account: EtherealAccount = {
    user: created.user,
    pass: created.pass,
    smtp: { host: created.smtp.host, port: created.smtp.port, secure: created.smtp.secure },
  };
  try {
    await redis.set(ETHEREAL_ACCOUNT_KEY, JSON.stringify(account), 'EX', ETHEREAL_ACCOUNT_TTL_SECONDS);
  } catch (err) {
    logger.warn('Ethereal account not cached in Redis', { reason: err instanceof Error ? err.message : String(err) });
  }
  // The login name is a throwaway, not a secret; the password is never logged.
  logger.info('Ethereal test inbox created', { user: account.user, webUrl: ETHEREAL_WEB_URL });
  return account;
}
