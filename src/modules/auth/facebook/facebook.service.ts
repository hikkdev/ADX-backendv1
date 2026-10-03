import { env } from '../../../config/env';
import { ApiError } from '../../../shared/errors';
import { getIntegrationsConfig } from '../../../shared/integrations';
import { logger } from '../../../shared/logging';

/**
 * FB-1 (the owner, 25 Sep 2026): "Continue with Facebook" on the website.
 *
 * The browser's Facebook SDK hands the site a short-lived user access
 * token. Two calls to the Graph API turn it into an identity ADX trusts:
 * `debug_token`, signed with the app's own credentials, says the token is
 * live and was issued for THIS app (a token for some other app is somebody
 * else's session, however valid); then `/me` names the person and, when
 * they granted it, their email. Facebook verifies the addresses it hands
 * out, so an email here is a proven mailbox — the same standing a Google
 * ID token's `email_verified` gives — and the sign-in treats it as one.
 */
export interface FacebookIdentity {
  /** Facebook's app-scoped user id. */
  id: string;
  email: string | null;
  name?: string;
}

export type FacebookConfig = { appId?: string | undefined; appSecret?: string | undefined };

const GRAPH = 'https://graph.facebook.com/v19.0';

export async function loadFacebookConfig(): Promise<FacebookConfig> {
  const cfg = (await getIntegrationsConfig()).facebook ?? {};
  return { appId: cfg.appId ?? env.FACEBOOK_APP_ID, appSecret: cfg.appSecret ?? env.FACEBOOK_APP_SECRET };
}

export async function facebookReadiness(): Promise<{ configured: boolean; missing: string[] }> {
  const cfg = await loadFacebookConfig();
  const missing = (['appId', 'appSecret'] as const).filter((key) => !cfg[key]);
  return { configured: missing.length === 0, missing };
}

type DebugToken = { data?: { app_id?: string; is_valid?: boolean; user_id?: string; error?: { message?: string } } };
type Me = { id?: string; name?: string; email?: string; error?: { message?: string } };

export async function verifyFacebookToken(
  accessToken: string,
  deps: { fetchImpl?: typeof fetch; config?: () => Promise<FacebookConfig> } = {},
): Promise<FacebookIdentity> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cfg = await (deps.config ?? loadFacebookConfig)();
  if (!cfg.appId || !cfg.appSecret) {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Facebook sign-in is not set up on this platform yet.');
  }

  const debug = await fetchImpl(`${GRAPH}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(`${cfg.appId}|${cfg.appSecret}`)}`);
  const inspected = (await debug.json().catch(() => ({}))) as DebugToken;
  if (!debug.ok || !inspected.data?.is_valid || inspected.data.app_id !== cfg.appId) {
    logger.warn('Facebook sign-in refused: the token did not check out', { status: debug.status, appId: inspected.data?.app_id, reason: inspected.data?.error?.message });
    throw new ApiError(401, 'UNAUTHORIZED', 'Facebook did not accept this sign-in. Try again.');
  }

  const me = await fetchImpl(`${GRAPH}/me?fields=id,name,email&access_token=${encodeURIComponent(accessToken)}`);
  const profile = (await me.json().catch(() => ({}))) as Me;
  if (!me.ok || !profile.id) {
    logger.warn('Facebook sign-in refused: the profile could not be read', { status: me.status, reason: profile.error?.message });
    throw new ApiError(401, 'UNAUTHORIZED', 'Facebook did not accept this sign-in. Try again.');
  }
  if (inspected.data.user_id && inspected.data.user_id !== profile.id) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Facebook did not accept this sign-in. Try again.');
  }
  return { id: profile.id, email: profile.email ? profile.email.trim().toLowerCase() : null, ...(profile.name ? { name: profile.name } : {}) };
}
