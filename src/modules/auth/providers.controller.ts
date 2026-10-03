import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { loadFacebookConfig } from './facebook/facebook.service';

/**
 * GET /auth/providers — which social sign-in doors are open, and the PUBLIC
 * ids a client needs to open them: Google's web client id (the audience the
 * backend checks an id token against) and Facebook's app id. Read before
 * sign-in by the apps, which hide a button whose provider is not set up.
 * Never a secret: the Facebook app secret stays on the server.
 */
export type AuthProviders = {
  google: { webClientId: string } | null;
  facebook: { appId: string } | null;
};

export async function authProviders(): Promise<AuthProviders> {
  const facebook = await loadFacebookConfig();
  return {
    google: env.GOOGLE_CLIENT_ID ? { webClientId: env.GOOGLE_CLIENT_ID } : null,
    facebook: facebook.appId && facebook.appSecret ? { appId: facebook.appId } : null,
  };
}

export async function authProvidersHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await authProviders() });
}
