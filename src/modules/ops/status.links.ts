import { env } from '../../config/env';

/**
 * The status page's links — Lot G (Q130). Root-mounted, like the scan
 * redirect and the package link: they are sent to somebody with no account
 * who may end up typing them.
 */
export function publicBaseUrl(): string {
  return (env.BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/$/, '');
}

export const confirmUrlFor = (token: string): string => `${publicBaseUrl()}/status/confirm/${encodeURIComponent(token)}`;
export const unsubscribeUrlFor = (token: string): string => `${publicBaseUrl()}/status/unsubscribe/${encodeURIComponent(token)}`;
