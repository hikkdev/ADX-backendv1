import { randomBytes } from 'crypto';
import { env } from '../../config/env';
import type { LeadInvite } from '../../shared/database';

/**
 * LH7 (D6): the invite link's arithmetic — pure, so the tests pin it and
 * `leads.service` can draw the view without reaching the door.
 */

/** Thirty days (D6). */
export const INVITE_DAYS = 30;
export const INVITE_MS = INVITE_DAYS * 24 * 60 * 60 * 1000;
/** Unambiguous: no 0/O, 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;
export const OPENS_KEPT = 50;

export function mintInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

export const isInviteCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z0-9]{6,12}$/.test(value);

/** `${PUBLIC_WEB_URL}/j/<code>` — the D6 domain when it is pointed, the API's base until then. */
export function inviteUrl(code: string): string {
  const base = (env.PUBLIC_WEB_URL ?? env.BASE_URL ?? 'https://adx.in').replace(/\/$/, '');
  return `${base}/j/${code}`;
}

/** The deep link the landing offers when the app is installed. */
export const inviteAppLink = (code: string): string => `adx://join/${code}`;

export type InviteOpen = { at: string; ua?: string | undefined };

export function readOpens(value: unknown): InviteOpen[] {
  if (!Array.isArray(value)) return [];
  return value.filter((o): o is InviteOpen => Boolean(o && typeof o === 'object' && typeof (o as { at?: unknown }).at === 'string'));
}

/** The opens with one more appended, the oldest dropped past the cap. */
export function withOpen(opens: unknown, at: Date, ua?: string | null): InviteOpen[] {
  const next = [...readOpens(opens), { at: at.toISOString(), ...(ua ? { ua: ua.slice(0, 120) } : {}) }];
  return next.length > OPENS_KEPT ? next.slice(next.length - OPENS_KEPT) : next;
}

export type InviteState = 'LIVE' | 'EXPIRED' | 'REVOKED' | 'CONVERTED';

export function inviteState(invite: Pick<LeadInvite, 'expiresAt' | 'revokedAt' | 'convertedAt'>, now: Date): InviteState {
  if (invite.convertedAt) return 'CONVERTED';
  if (invite.revokedAt) return 'REVOKED';
  if (invite.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'LIVE';
}

export type InviteView = {
  id: string;
  code: string;
  url: string;
  appLink: string;
  expiresAt: string;
  state: InviteState;
  opens: number;
  lastOpenedAt: string | null;
  convertedAt: string | null;
  createdAt: string;
};

export function inviteView(invite: LeadInvite, now = new Date()): InviteView {
  const opens = readOpens(invite.opens);
  return {
    id: invite.id,
    code: invite.code,
    url: inviteUrl(invite.code),
    appLink: inviteAppLink(invite.code),
    expiresAt: invite.expiresAt.toISOString(),
    state: inviteState(invite, now),
    opens: opens.length,
    lastOpenedAt: opens.length ? opens[opens.length - 1]!.at : null,
    convertedAt: invite.convertedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
  };
}

/** "opened 2 h ago" — the line the agent's detail prints; null when never opened. */
export function openedAgo(lastOpenedAt: string | null, now = new Date()): string | null {
  if (!lastOpenedAt) return null;
  const ms = now.getTime() - new Date(lastOpenedAt).getTime();
  if (ms < 60_000) return 'opened just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `opened ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `opened ${hours} h ago`;
  return `opened ${Math.round(hours / 24)} d ago`;
}
