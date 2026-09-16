import { createSign } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../logging';

/**
 * FCM HTTP v1 — G6 (Q103/133): the one door a push leaves ADX by.
 *
 * No firebase-admin. The service account from `FIREBASE_SERVICE_ACCOUNT_JSON`
 * (raw or base64) signs a JWT grant with node:crypto (RS256), the token
 * endpoint swaps it for an hour-long access token, and each message is one
 * POST to `projects/<id>/messages:send`. The access token is cached until a
 * minute before it expires; a 401 clears it and the next send mints again.
 *
 * Absent configuration is not an error: the sender answers
 * `{ skipped: true, reason: 'FCM_NOT_CONFIGURED' }` and says so once in the
 * log, so a developer's laptop and a staging box without Firebase behave
 * exactly like production with the rail switched off. A malformed key is
 * the same answer with `FCM_MISCONFIGURED`.
 *
 * The one answer the caller has to act on is `UNREGISTERED`: the device
 * uninstalled the app or rotated its token, and FCM will never deliver to
 * it again. The notifications module deletes the row on that answer.
 */

export interface PushMessage {
  /** The visible notice; omit for a silent data push. */
  notification?: { title: string; body: string } | undefined;
  /** String values only — FCM rejects anything else. */
  data?: Record<string, string> | undefined;
  /** iOS wakes the app for a silent push only when told to. Default true when `notification` is absent. */
  contentAvailable?: boolean | undefined;
}

export type PushSendResult =
  | { skipped: true; reason: 'FCM_NOT_CONFIGURED' | 'FCM_MISCONFIGURED' }
  | { skipped?: false; ok: true; messageId: string }
  | { skipped?: false; ok: false; error: 'UNREGISTERED' | 'INVALID_TOKEN' | 'QUOTA' | 'UNAVAILABLE' | 'UNAUTHENTICATED' | 'FCM_ERROR'; status: number; detail: string };

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface FcmDeps {
  fetchImpl?: Fetch;
  now?: () => Date;
  /** Overrides the env-read for tests. */
  serviceAccountJson?: string | null | undefined;
}

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The service account, or null with the reason. Read from the env unless a test hands one in. */
export function readServiceAccount(raw: string | null | undefined = env.FIREBASE_SERVICE_ACCOUNT_JSON): { account: ServiceAccount | null; reason: 'FCM_NOT_CONFIGURED' | 'FCM_MISCONFIGURED' | null } {
  const value = raw?.trim();
  if (!value) return { account: null, reason: 'FCM_NOT_CONFIGURED' };
  const candidates = [value];
  if (!value.startsWith('{')) {
    try {
      candidates.unshift(Buffer.from(value, 'base64').toString('utf8'));
    } catch {
      /* not base64 — fall through to the raw parse, which will say so */
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ServiceAccount>;
      if (parsed && typeof parsed.project_id === 'string' && typeof parsed.client_email === 'string' && typeof parsed.private_key === 'string') {
        return { account: { project_id: parsed.project_id, client_email: parsed.client_email, private_key: parsed.private_key, token_uri: parsed.token_uri }, reason: null };
      }
    } catch {
      /* try the next form */
    }
  }
  return { account: null, reason: 'FCM_MISCONFIGURED' };
}

/** The RS256-signed JWT grant for the token endpoint. Exported for the test that checks the claims. */
export function signJwtGrant(account: ServiceAccount, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: account.token_uri ?? TOKEN_URI, iat, exp: iat + TOKEN_LIFETIME_SECONDS }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = base64url(signer.sign(account.private_key));
  return `${header}.${claims}.${signature}`;
}

export function createFcmSender(deps: FcmDeps = {}) {
  const fetchImpl: Fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  let cached: { token: string; expiresAt: number } | null = null;
  let warnedOnce = false;

  function configuration(): { account: ServiceAccount | null; reason: 'FCM_NOT_CONFIGURED' | 'FCM_MISCONFIGURED' | null } {
    const read = readServiceAccount(deps.serviceAccountJson === undefined ? env.FIREBASE_SERVICE_ACCOUNT_JSON : deps.serviceAccountJson);
    if (!read.account && !warnedOnce) {
      warnedOnce = true;
      logger.warn(read.reason === 'FCM_NOT_CONFIGURED' ? 'Push is off: FIREBASE_SERVICE_ACCOUNT_JSON is not set' : 'Push is off: FIREBASE_SERVICE_ACCOUNT_JSON could not be read', { reason: read.reason });
    }
    return read;
  }

  async function accessToken(account: ServiceAccount): Promise<string> {
    const at = Math.floor(now().getTime() / 1000);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_SECONDS > at) return cached.token;
    const assertion = signJwtGrant(account, now());
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    const response = await fetchImpl(account.token_uri ?? TOKEN_URI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`FCM token endpoint answered ${response.status}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new Error('FCM token endpoint answered without an access_token');
    cached = { token: parsed.access_token, expiresAt: at + (parsed.expires_in ?? TOKEN_LIFETIME_SECONDS) };
    return cached.token;
  }

  function classify(status: number, text: string): Exclude<PushSendResult, { skipped: true } | { ok: true }>['error'] {
    const upper = text.toUpperCase();
    if (status === 404 || upper.includes('UNREGISTERED')) return 'UNREGISTERED';
    if (status === 400 && (upper.includes('REGISTRATION TOKEN') || upper.includes('INVALID_ARGUMENT'))) return 'INVALID_TOKEN';
    if (status === 401 || status === 403) return 'UNAUTHENTICATED';
    if (status === 429) return 'QUOTA';
    if (status >= 500) return 'UNAVAILABLE';
    return 'FCM_ERROR';
  }

  /** One message to one device token. Never throws on FCM's own answer; throws only when the network or the token mint fails. */
  async function send(token: string, message: PushMessage): Promise<PushSendResult> {
    const { account, reason } = configuration();
    if (!account) return { skipped: true, reason: reason! };

    const silent = !message.notification;
    const payload = {
      message: {
        token,
        notification: message.notification,
        data: message.data,
        android: { priority: 'high' as const },
        apns: {
          headers: { 'apns-priority': silent ? '5' : '10' },
          payload: { aps: { 'content-available': message.contentAvailable ?? silent ? 1 : 0, ...(silent ? {} : { sound: 'default' }) } },
        },
      },
    };

    const attempt = async (bearer: string) =>
      fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

    let response = await attempt(await accessToken(account));
    if (response.status === 401) {
      // A token FCM stopped honouring: mint once more, then report.
      cached = null;
      response = await attempt(await accessToken(account));
    }
    const text = await response.text();
    if (response.ok) {
      const parsed = JSON.parse(text) as { name?: string };
      return { ok: true, messageId: parsed.name ?? '' };
    }
    return { ok: false, error: classify(response.status, text), status: response.status, detail: text.slice(0, 500) };
  }

  return {
    send,
    /** Whether a send would leave at all — the dispatcher asks before it queues. */
    isConfigured: () => Boolean(configuration().account),
    /** For the tests: forget the cached bearer. */
    resetToken: () => {
      cached = null;
    },
  };
}

export type FcmSender = ReturnType<typeof createFcmSender>;

/** The process-wide sender, on the real fetch and the env. */
export const fcm: FcmSender = createFcmSender();
