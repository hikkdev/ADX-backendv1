import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

/**
 * PB-1 (27 Sep 2026): preview tokens — Studio's "see the draft on the real
 * page" without a session on the website.
 *
 * Signed with the access secret so nothing new has to be configured, but
 * never an access token: the payload carries `purpose: 'preview'`, which
 * `verifyAccessToken` refuses outright, so a leaked preview link opens
 * exactly one thing — the draft of the one page or surface it names — for
 * a day, and nothing else.
 */

export type PreviewClaim = { kind: 'page' | 'surface'; ref: string };

export const PREVIEW_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** `POST …/preview-token` — a token for one page or surface, good for a day. */
export function signPreviewToken(claim: PreviewClaim, now = new Date()): { token: string; expiresAt: Date } {
  const token = jwt.sign({ purpose: 'preview', kind: claim.kind, ref: claim.ref }, env.JWT_ACCESS_SECRET, { expiresIn: PREVIEW_TOKEN_TTL_SECONDS });
  return { token, expiresAt: new Date(now.getTime() + PREVIEW_TOKEN_TTL_SECONDS * 1000) };
}

/** Whether `token` is a live preview token for exactly this page or surface. Anything else — expired, another ref, an access token — is false. */
export function verifyPreviewToken(token: string | null | undefined, claim: PreviewClaim): boolean {
  if (!token) return false;
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof payload !== 'object' || payload === null) return false;
    const record = payload as Record<string, unknown>;
    return record['purpose'] === 'preview' && record['kind'] === claim.kind && record['ref'] === claim.ref;
  } catch {
    return false;
  }
}
