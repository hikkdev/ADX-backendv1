import type { SupportPriority } from '../app-config';

/**
 * The support SLA — Lot D (Q53/Q91).
 *
 * Two clocks on every ticket: first response and resolution. The targets per
 * priority live in the platform settings row (`support.sla`) and default to
 * URGENT 1h/4h, HIGH 4h/24h, NORMAL 8h/72h, LOW 24h/7d. Both are computed at
 * creation and again whenever the priority moves — from the creation time,
 * never from "now", so re-prioritising a ticket that has sat for a day does
 * not hand it a fresh clock.
 *
 * WAITING pauses both. The pause is recorded as `slaPausedAt` while it runs
 * and banked into `slaPausedMs` when it ends, and the due dates move by the
 * same amount, so a ticket waiting three hours on the requester is not
 * breached for those three hours. Breach is derived on read (`slaView`),
 * never stored: a stored flag is a flag that is wrong the moment the
 * settings change.
 */

export const HOUR_MS = 60 * 60 * 1000;

export type SlaTargets = Record<SupportPriority, { firstResponseHours: number; resolutionHours: number }>;

/**
 * The priority a ticket opens at when nobody chose one. Safety and money are
 * HIGH — the person is either at risk or out of pocket; an account question
 * is NORMAL; feedback is LOW, because nobody is waiting on an idea.
 */
const PRIORITY_BY_CATEGORY: Record<string, SupportPriority> = {
  SAFETY: 'HIGH',
  PAYMENT: 'HIGH',
  ACCOUNT: 'NORMAL',
  ACCESS: 'NORMAL',
  ORDER: 'NORMAL',
  LISTING: 'NORMAL',
  APP_BUG: 'NORMAL',
  OTHER: 'NORMAL',
};

export function defaultPriorityFor(category: string, kind: 'ISSUE' | 'FEEDBACK'): SupportPriority {
  if (kind === 'FEEDBACK') return 'LOW';
  return PRIORITY_BY_CATEGORY[category.toUpperCase()] ?? 'NORMAL';
}

/** Both due dates, from the creation time, shifted by the pause already banked. */
export function slaDueAts(
  createdAt: Date,
  priority: SupportPriority,
  targets: SlaTargets,
  pausedMs: number,
): { slaFirstResponseDueAt: Date; slaResolutionDueAt: Date } {
  const target = targets[priority];
  return {
    slaFirstResponseDueAt: new Date(createdAt.getTime() + target.firstResponseHours * HOUR_MS + pausedMs),
    slaResolutionDueAt: new Date(createdAt.getTime() + target.resolutionHours * HOUR_MS + pausedMs),
  };
}

/** The slice of a ticket the read needs to say whether it is late. */
export type SlaFields = {
  status: string;
  slaFirstResponseDueAt: Date | null;
  slaResolutionDueAt: Date | null;
  firstRespondedAt: Date | null;
  slaPausedAt: Date | null;
};

export type SlaView = {
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  /** True while WAITING on the requester — the clock is stopped. */
  paused: boolean;
  /**
   * Milliseconds until the next clock runs out — first response until it is
   * given, resolution after — negative once it has, null once the ticket is
   * closed or carries no clock.
   */
  dueIn: number | null;
  /** The due dates as they stand, with a running pause added on. */
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
};

/**
 * Whether the ticket is late, at `now`. A pause that is still running is
 * added to both due dates before the comparison, so a ticket WAITING on the
 * requester never breaches while it waits.
 */
export function slaView(ticket: SlaFields, now: Date = new Date()): SlaView {
  const closed = ticket.status === 'CLOSED';
  const paused = ticket.status === 'WAITING' && ticket.slaPausedAt !== null;
  const running = paused ? Math.max(0, now.getTime() - ticket.slaPausedAt!.getTime()) : 0;
  const shift = (at: Date | null) => (at ? new Date(at.getTime() + running) : null);
  const firstResponseDueAt = shift(ticket.slaFirstResponseDueAt);
  const resolutionDueAt = shift(ticket.slaResolutionDueAt);

  const firstResponseBreached =
    !closed && !paused && ticket.firstRespondedAt === null && firstResponseDueAt !== null && firstResponseDueAt.getTime() < now.getTime();
  const resolutionBreached = !closed && !paused && resolutionDueAt !== null && resolutionDueAt.getTime() < now.getTime();

  const next = closed ? null : ticket.firstRespondedAt === null ? firstResponseDueAt : resolutionDueAt;
  return {
    firstResponseBreached,
    resolutionBreached,
    paused,
    dueIn: next ? next.getTime() - now.getTime() : null,
    firstResponseDueAt,
    resolutionDueAt,
  };
}
