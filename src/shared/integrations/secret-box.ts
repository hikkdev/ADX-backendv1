import crypto from 'crypto';
import { env } from '../../config/env';
import { ApiError } from '../errors/api-error';
import { logger } from '../logging';

/**
 * Cashfree Phase 1 (the owner, 1 Oct 2026: "Go ahead, Encrypt it") — the
 * integrations row's secrets, sealed at rest.
 *
 * The keys saved on the console's integration cards sat in the `AppConfig`
 * row as plain JSON and were only masked on the way out (the Phase 0 audit).
 * From here every secret field of the row is AES-256-GCM ciphertext in the
 * database AND in the Redis cache; it is opened only in memory, by
 * `integration-config.ts`, on the way to the code that spends it.
 *
 *   stored form   enc:v1:<iv>:<tag>:<ciphertext>      (each part base64)
 *   key           INTEGRATIONS_ENCRYPTION_KEY — 32 bytes, base64 (or 64 hex)
 *
 * Modelled on the authenticator secrets (`modules/auth/two-factor/totp.ts`,
 * TOTP_ENCRYPTION_KEY) — the same cipher and the same three base64 parts;
 * the helpers are written again here because `shared` may not import a
 * module, and because this key is never derived from another secret: a
 * derived key would make the JWT secret the key to every vendor.
 *
 * Three rules:
 *   - A value WITHOUT the prefix is plaintext written before this existed.
 *     It reads as it is, and is sealed the next time the row is written (or
 *     by `npm run integrations:encrypt -- --write`).
 *   - No key: development keeps the row in plaintext and says so ONCE per
 *     boot; production refuses to save a secret (503 ENCRYPTION_KEY_MISSING).
 *   - Neither a secret nor a ciphertext is ever logged — only the section
 *     and field names.
 */

export const SECRET_PREFIX = 'enc:v1:';

/**
 * Which fields of each section are secrets — every field the read mapper
 * masks (`integrations.mapper.ts`, `maskSecret(...)`) plus the Secure ID
 * pair. A dotted path reaches into a card of a section (`meta.appSecret`).
 * `tests/…/secret-box.test.ts` pins this list against the mapper, so a new
 * masked field that is not registered here fails the suite.
 */
export const INTEGRATION_SECRET_FIELDS: Readonly<Record<string, readonly string[]>> = {
  sms: ['authKey'],
  email: ['password'],
  storage: ['accessKeyId', 'secretAccessKey'],
  kyc: ['clientId', 'clientSecret'],
  esign: ['clientId', 'clientSecret'],
  twilio: ['authToken'],
  resend: ['apiKey'],
  googleMaps: ['apiKey'],
  razorpay: ['keySecret', 'webhookSecret'],
  cashfree: ['secretKey', 'webhookSecret'],
  ccavenue: ['accessCode', 'workingKey'],
  stripe: ['secretKey', 'webhookSecret'],
  facebook: ['appSecret'],
  geoIp: ['token'],
  ai: ['apiKey'],
  hrms: ['apiKey'],
  maps: ['googleBrowserKey', 'googleServerKey', 'mapboxPublicToken', 'mapboxSecretToken', 'osm.tileApiKey'],
  audience: ['geoiqApiKey', 'aziraApiKey'],
  qrEngine: ['apiKey'],
  leadFeeds: ['justdial.apiKey', 'indiamart.apiKey', 'mca.apiKey', 'gst.apiKey', 'rera.apiKey'],
  leadForms: ['meta.appSecret', 'meta.verifyToken', 'meta.pageAccessToken', 'google.key', 'linkedin.clientSecret'],
  leadChannels: [
    'whatsapp.apiKey',
    'whatsapp.accessToken',
    'whatsapp.appSecret',
    'whatsapp.verifyToken',
    'instagram.accessToken',
    'instagram.appSecret',
    'instagram.verifyToken',
    'messenger.accessToken',
    'messenger.appSecret',
    'messenger.verifyToken',
    'googleBusiness.serviceAccountJson',
    'googleBusiness.partnerKey',
    'telephony.apiKey',
    'telephony.apiToken',
    'telephony.webhookSecret',
  ],
  // Cashfree Phase 1: the Secure ID client secret and the 2FA public key (PEM).
  secureId: ['clientSecret', 'publicKey'],
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 32 bytes as base64, or as 64 hex characters — the two shapes `env.ts` lets through. */
export function decodeKey(configured: string): Buffer {
  const raw = /^[0-9a-fA-F]{64}$/.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64');
  if (raw.length !== 32) throw new Error('INTEGRATIONS_ENCRYPTION_KEY must decode to 32 bytes');
  return raw;
}

/** The key in force, or null when none is set. Read on every call so a test may set and clear it. */
export function integrationsKey(): Buffer | null {
  const configured = env.INTEGRATIONS_ENCRYPTION_KEY;
  return configured ? decodeKey(configured) : null;
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

/** `enc:v1:<iv>:<tag>:<ciphertext>` — a fresh 12-byte IV every time, so sealing the same value twice never matches. */
export function sealSecret(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${SECRET_PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Throws when the value is not a sealed secret, or was sealed under another key (the GCM tag fails). */
export function openSecret(sealed: string, key: Buffer): string {
  if (!isSealed(sealed)) throw new Error('Not a sealed secret');
  const [iv, tag, ciphertext] = sealed.slice(SECRET_PREFIX.length).split(':');
  if (!iv || !tag || ciphertext === undefined) throw new Error('Not a sealed secret');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Every secret slot the row actually holds: the object the field sits on, its name, and `section.path` for a message. */
function* secretSlots(cfg: Json): Generator<{ holder: Json; field: string; name: string }> {
  for (const [section, paths] of Object.entries(INTEGRATION_SECRET_FIELDS)) {
    const root = cfg[section];
    if (!isObject(root)) continue;
    for (const path of paths) {
      const parts = path.split('.');
      const field = parts.pop()!;
      let holder: unknown = root;
      for (const part of parts) holder = isObject(holder) ? holder[part] : undefined;
      if (isObject(holder) && field in holder) yield { holder, field, name: `${section}.${path}` };
    }
  }
}

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

let warnedNoKey = false;
const warnedUnreadable = new Set<string>();

/** For tests: the once-per-boot flags, cleared. */
export function resetSecretBoxWarnings(): void {
  warnedNoKey = false;
  warnedUnreadable.clear();
}

function warnNoKeyOnce(): void {
  if (warnedNoKey) return;
  warnedNoKey = true;
  logger.warn('INTEGRATIONS_ENCRYPTION_KEY is not set — integration secrets are kept in plaintext on this machine (development only; production refuses to save one)');
}

/**
 * The row as it is stored: every plaintext secret sealed. A value already
 * sealed is left exactly as it is — including one this key cannot open, so
 * a wrong key can never destroy what the right one wrote. With no key the
 * row is returned unchanged (development); the caller has already refused
 * in production (`assertSecretsStorable`).
 */
export function sealIntegrationSecrets<T extends object>(cfg: T): T {
  const key = integrationsKey();
  if (!key) {
    warnNoKeyOnce();
    return cfg;
  }
  const sealed = clone(cfg);
  for (const { holder, field } of secretSlots(sealed as Json)) {
    const value = holder[field];
    if (typeof value === 'string' && value !== '' && !isSealed(value)) holder[field] = sealSecret(value, key);
  }
  return sealed;
}

/**
 * The row as the code reads it: every sealed secret opened. A plaintext
 * value passes through (a row written before the key existed). A sealed
 * value that cannot be opened — no key on this machine, or another key —
 * reads as absent, so the integration says "not configured" rather than
 * sending ciphertext to a vendor; the field is named once in the log.
 */
export function openIntegrationSecrets<T extends object>(cfg: T): T {
  const key = integrationsKey();
  if (!key) warnNoKeyOnce();
  const opened = clone(cfg);
  for (const { holder, field, name } of secretSlots(opened as Json)) {
    const value = holder[field];
    if (!isSealed(value)) continue;
    try {
      if (!key) throw new Error('no key');
      holder[field] = openSecret(value, key);
    } catch {
      delete holder[field];
      if (!warnedUnreadable.has(name)) {
        warnedUnreadable.add(name);
        logger.error('An integration secret is sealed and cannot be opened with INTEGRATIONS_ENCRYPTION_KEY on this machine; it reads as not set', { field: name, keyPresent: Boolean(key) });
      }
    }
  }
  return opened;
}

export type SecretFieldState = { field: string; state: 'PLAINTEXT' | 'SEALED' | 'UNREADABLE' };

/** Section and field names only — what `integrations:encrypt --check` prints. Never a value. */
export function describeIntegrationSecrets(cfg: object): SecretFieldState[] {
  const key = integrationsKey();
  const rows: SecretFieldState[] = [];
  for (const { holder, field, name } of secretSlots(cfg as Json)) {
    const value = holder[field];
    if (typeof value !== 'string' || value === '') continue;
    if (!isSealed(value)) {
      rows.push({ field: name, state: 'PLAINTEXT' });
      continue;
    }
    let readable = false;
    if (key) {
      try {
        openSecret(value, key);
        readable = true;
      } catch {
        readable = false;
      }
    }
    rows.push({ field: name, state: readable ? 'SEALED' : 'UNREADABLE' });
  }
  return rows;
}

/** Does this patch to a section write a secret (a non-empty string on a registered field)? */
export function patchCarriesSecret(section: string, patch: Record<string, unknown>): boolean {
  for (const slot of secretSlots({ [section]: patch })) {
    const value = slot.holder[slot.field];
    if (typeof value === 'string' && value !== '') return true;
  }
  return false;
}

/**
 * Production with no key refuses to save a secret — 503
 * ENCRYPTION_KEY_MISSING — rather than write it in the clear. A patch that
 * carries no secret (the Digio switch, a routing table) is still saved: the
 * probe flips that switch on its own, and it must not need the key to do so.
 */
export function assertSecretsStorable(section: string, patch: Record<string, unknown>): void {
  if (integrationsKey()) return;
  if (env.NODE_ENV !== 'production') return;
  if (!patchCarriesSecret(section, patch)) return;
  throw new ApiError(
    503,
    'ENCRYPTION_KEY_MISSING',
    'This server has no INTEGRATIONS_ENCRYPTION_KEY, so it will not store a credential. Set the key in the environment and save again.',
    { section },
  );
}
