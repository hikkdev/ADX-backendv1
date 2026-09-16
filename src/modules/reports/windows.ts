import type { ReportCadence } from '../../shared/database';
import { dayWindowISTFor, monthWindowIST } from '../../shared/time';
import type { Window } from './reports.repository';

/**
 * Report windows and schedule times — Lot G (Q129/Q143). Everything here is
 * in Indian time: a report "for yesterday" is the Indian yesterday, a
 * schedule fires at 06:00 IST, and the window a schedule renders is the
 * period that ended at the Indian midnight before it fired.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 06:00 IST, the hour every cadence fires at. */
export const SCHEDULE_HOUR_IST = 6;

export const WINDOW_PRESETS = ['today', 'yesterday', 'last7', 'last30', 'lastMonth', 'monthToDate'] as const;
export type WindowPreset = (typeof WINDOW_PRESETS)[number];

export type WindowInput = { preset: WindowPreset } | { from: string; to: string };

export interface LabelledWindow extends Window {
  /** `2026-09-01 → 2026-09-13`, the Indian days the window covers, inclusive. */
  label: string;
  from: string;
  to: string;
}

const istDay = (at: Date): string => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const shiftDays = (day: string, days: number): string => istDay(new Date(dayWindowISTFor(day).start.getTime() + days * DAY_MS));

function labelled(from: string, to: string): LabelledWindow {
  const start = dayWindowISTFor(from).start;
  const end = dayWindowISTFor(to).end;
  return { start, end, from, to, label: from === to ? from : `${from} → ${to}` };
}

/** The Indian days a preset names, as an inclusive `[from, to]` and the instants behind them. */
export function resolveWindow(input: WindowInput, now = new Date()): LabelledWindow {
  if ('from' in input) return labelled(input.from, input.to);
  const today = istDay(now);
  switch (input.preset) {
    case 'today':
      return labelled(today, today);
    case 'yesterday': {
      const yesterday = shiftDays(today, -1);
      return labelled(yesterday, yesterday);
    }
    case 'last7':
      return labelled(shiftDays(today, -7), shiftDays(today, -1));
    case 'last30':
      return labelled(shiftDays(today, -30), shiftDays(today, -1));
    case 'monthToDate':
      return labelled(`${today.slice(0, 7)}-01`, today);
    case 'lastMonth': {
      const [y, m] = today.split('-').map(Number) as [number, number];
      const { start, end } = monthWindowIST(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1);
      return labelled(istDay(start), istDay(new Date(end.getTime() - 1)));
    }
  }
}

/** G13-B: the instant this Indian week opened — Monday 00:00 IST at or before `now`. */
export function weekStartIST(now = new Date()): Date {
  const today = istDay(now);
  const weekday = new Date(now.getTime() + IST_OFFSET_MS).getUTCDay(); // 0 Sunday … 1 Monday
  const sinceMonday = (weekday + 6) % 7;
  return dayWindowISTFor(shiftDays(today, -sinceMonday)).start;
}

/** The period a schedule renders when it fires: yesterday, the seven days before today, the month before this one. */
export function windowForCadence(cadence: ReportCadence, now = new Date()): LabelledWindow {
  switch (cadence) {
    case 'DAILY':
      return resolveWindow({ preset: 'yesterday' }, now);
    case 'WEEKLY':
      return resolveWindow({ preset: 'last7' }, now);
    case 'MONTHLY':
      return resolveWindow({ preset: 'lastMonth' }, now);
  }
}

/**
 * The next 06:00 IST a cadence fires at, strictly after `after`: tomorrow
 * (or today, if it is still before six), next Monday, the first of next
 * month. Computed on the IST-shifted clock, then shifted back.
 */
export function nextRunAtFor(cadence: ReportCadence, after = new Date()): Date {
  const shifted = new Date(after.getTime() + IST_OFFSET_MS);
  const at = (y: number, m: number, d: number) => Date.UTC(y, m, d, SCHEDULE_HOUR_IST, 0, 0, 0);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();

  let candidate: number;
  switch (cadence) {
    case 'DAILY':
      candidate = at(y, m, d);
      if (candidate <= shifted.getTime()) candidate = at(y, m, d + 1);
      break;
    case 'WEEKLY': {
      const weekday = shifted.getUTCDay(); // 0 Sunday … 1 Monday
      const toMonday = (8 - weekday) % 7; // days until the next Monday, 0 when today is one
      candidate = at(y, m, d + toMonday);
      if (candidate <= shifted.getTime()) candidate = at(y, m, d + toMonday + 7);
      break;
    }
    case 'MONTHLY':
      candidate = at(y, m, 1);
      if (candidate <= shifted.getTime()) candidate = at(y, m + 1, 1);
      break;
  }
  return new Date(candidate - IST_OFFSET_MS);
}

