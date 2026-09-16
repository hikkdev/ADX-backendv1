import { Decimal, money, type Money } from '../../../shared/money';

/**
 * The pure half of the milestone board — how a template and an agent's row
 * become a state, a deadline and the line under the title. No I/O. The
 * derivation of `progress` itself lives in the service, because it reads four
 * different counters; everything downstream of that number is decided here.
 */

export const MILESTONE_STATES = ['LOCKED', 'UPCOMING', 'ACTIVE', 'COMPLETED', 'CLAIMED', 'EXPIRED'] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

/** The board's four chips. `ALL` is not a state, it is the absence of one. */
export const MILESTONE_CHIPS = ['ALL', 'ACTIVE', 'UPCOMING', 'COMPLETED'] as const;
export type MilestoneChip = (typeof MILESTONE_CHIPS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export type TemplateRules = {
  target: number;
  windowDays: number | null;
  startsAt: Date | null;
  unlockAfter: number | null;
};

export type RowRules = {
  createdAt: Date;
  completedAt: Date | null;
  claimedAt: Date | null;
};

/**
 * The window a milestone counts inside.
 *
 * A template with neither a start nor a length counts everything the agent
 * has ever done — the same all-time count the tier ladder climbs on. Given a
 * length but no start, the agent's own row is the start: the clock began when
 * the milestone first appeared on their board. `to` is null when the window
 * never closes.
 */
export function windowOf(template: TemplateRules, row: RowRules): { from: Date | null; to: Date | null } {
  const from = template.startsAt ?? (template.windowDays ? row.createdAt : null);
  const to = from && template.windowDays ? new Date(from.getTime() + template.windowDays * DAY_MS) : null;
  return { from, to };
}

/**
 * Which chip the card wears.
 *
 * A claim outranks everything; a completion outranks a lock or a closed
 * window because the work was done. Below that, the lock is checked before
 * the start date: "complete 2 milestones first" is the more useful thing to
 * tell someone than "starts in 5 days" when both are true.
 */
export function stateOf(input: {
  template: TemplateRules;
  row: RowRules;
  progress: number;
  completedByAgent: number;
  now: Date;
}): MilestoneState {
  const { template, row, progress, completedByAgent, now } = input;
  if (row.claimedAt) return 'CLAIMED';
  if (row.completedAt || progress >= template.target) return 'COMPLETED';
  if ((template.unlockAfter ?? 0) > completedByAgent) return 'LOCKED';
  if (template.startsAt && template.startsAt.getTime() > now.getTime()) return 'UPCOMING';
  const { to } = windowOf(template, row);
  if (to && to.getTime() < now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

/** Which chip a state is filed under. LOCKED is upcoming work; EXPIRED is under ALL only. */
export function chipOf(state: MilestoneState): MilestoneChip | null {
  switch (state) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'UPCOMING':
    case 'LOCKED':
      return 'UPCOMING';
    case 'COMPLETED':
    case 'CLAIMED':
      return 'COMPLETED';
    case 'EXPIRED':
      return null;
  }
}

/** The state chip on the card, as the frame draws it. */
export function milestoneChipOf(state: MilestoneState): { label: string; tone: string } {
  switch (state) {
    case 'ACTIVE':
      return { label: 'In progress', tone: 'new' };
    case 'UPCOMING':
      return { label: 'Upcoming', tone: 'new' };
    case 'LOCKED':
      return { label: 'Locked', tone: 'neutral' };
    case 'COMPLETED':
      return { label: 'Completed', tone: 'live' };
    case 'CLAIMED':
      return { label: 'Claimed', tone: 'live' };
    case 'EXPIRED':
      return { label: 'Ended', tone: 'neutral' };
  }
}

/** Whole days from `now` to `at`, rounded up: an hour away is "in 1 day". */
export function daysUntil(at: Date, now: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / DAY_MS));
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
// Our own table: a locale's "short" month is "Sept" in en-GB and "Sep" in
// en-IN, and the frame prints three letters.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The calendar day and month of an instant, in India. */
function istParts(at: Date): { day: number; month: string } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return { day: shifted.getUTCDate(), month: MONTHS[shifted.getUTCMonth()]! };
}

/** "05 Jul" — the Indian day, the way the frame prints it. */
export function shortDateIST(at: Date): string {
  const { day, month } = istParts(at);
  return `${String(day).padStart(2, '0')} ${month}`;
}

/** "30th APR" on the pinned tracker. */
export function deadlineLabel(at: Date): string {
  const { day, month } = istParts(at);
  const suffix =
    day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix} ${month.toUpperCase()}`;
}

/**
 * The line under the title: a timing or a precondition, never both.
 * Null on an active milestone with no deadline — there is nothing to say.
 */
export function timingOf(input: {
  state: MilestoneState;
  template: TemplateRules;
  row: RowRules;
  now: Date;
}): string | null {
  const { state, template, row, now } = input;
  const { to } = windowOf(template, row);
  switch (state) {
    case 'LOCKED': {
      const n = template.unlockAfter ?? 0;
      return `Complete ${n} milestone${n === 1 ? '' : 's'} first`;
    }
    case 'UPCOMING': {
      const days = daysUntil(template.startsAt!, now);
      return days === 0 ? 'Starts today' : `Starts in ${days} day${days === 1 ? '' : 's'}`;
    }
    case 'ACTIVE': {
      if (!to) return null;
      const days = daysUntil(to, now);
      return days === 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`;
    }
    case 'COMPLETED':
      return row.completedAt ? `Completed ${shortDateIST(row.completedAt)}` : 'Completed';
    case 'CLAIMED':
      return row.claimedAt ? `Claimed ${shortDateIST(row.claimedAt)}` : 'Claimed';
    case 'EXPIRED':
      return to ? `Ended ${shortDateIST(to)}` : 'Ended';
  }
}

/** Percent complete, whole number, capped at 100. */
export function pctOf(progress: number, target: number): number {
  if (target <= 0) return 100;
  return Math.min(100, Math.floor((progress / target) * 100));
}

/**
 * A REVENUE milestone's progress is rupees, and the card prints them as
 * money. The integer the tracker segments on is the whole-rupee floor; the
 * amount itself travels beside it as a decimal string.
 */
export function rupeesProgress(sum: Decimal | string | number): { progress: number; amount: Money } {
  const decimal = new Decimal(sum);
  return { progress: decimal.floor().toNumber(), amount: money(decimal) };
}
