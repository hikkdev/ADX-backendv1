/**
 * The times an agent is offered to propose — DR 01's "Available slots" sheet
 * (3424:26863: Today 5:00–7:00 PM · Tomorrow 10:00 AM–12:00 PM · 03/06/2026
 * 4:00–6:00 PM · CONFIRM SCHEDULE).
 *
 * No publisher keeps a calendar on ADX, so the candidates are DERIVED rather
 * than read: three two-hour bands a day in Indian time, over the days ahead,
 * inside the booking's own dates, minus any band in which the same publisher
 * already has an agent coming. That is a real answer built from real bookings
 * — not the publisher's preference, which nothing records yet. When a
 * preference model exists it narrows this list; the sheet does not change.
 *
 * Pure: the service hands in the instant, the booking window and the slots
 * already taken, and gets the list back.
 */

export type SlotCandidate = {
  /** ISO instants. */
  start: string;
  end: string;
  /** "Today", "Tomorrow", then the date as the sheet prints it: DD/MM/YYYY. */
  label: string;
};

/** Start hours of the three daily bands, Indian time. Each is two hours long. */
export const SLOT_BANDS_IST = [10, 14, 17] as const;
export const SLOT_BAND_HOURS = 2;

/** The first band offered must still be this far ahead — an agent has to get there. */
export const SLOT_MIN_LEAD_MS = 60 * 60 * 1000;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Midnight, Indian time, of the day containing the instant — as a UTC instant. */
export function startOfDayIST(at: Date): Date {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnight - IST_OFFSET_MS);
}

function dateLabelIST(at: Date): string {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${shifted.getUTCFullYear()}`;
}

export type SlotCandidateInput = {
  now: Date;
  /** The booking's dates. Null means unconstrained on that side. */
  from: Date | null;
  to: Date | null;
  /** Slot starts the same publisher already has confirmed. */
  taken: readonly Date[];
  /** How many to offer. The sheet draws three. */
  count?: number;
  /** How far ahead to look before giving up. */
  horizonDays?: number;
};

export function slotCandidates({
  now,
  from,
  to,
  taken,
  count = 3,
  horizonDays = 7,
}: SlotCandidateInput): SlotCandidate[] {
  const earliest = Math.max(now.getTime() + SLOT_MIN_LEAD_MS, from?.getTime() ?? 0);
  const latest = to?.getTime() ?? Number.POSITIVE_INFINITY;
  const today = startOfDayIST(now).getTime();

  const out: SlotCandidate[] = [];
  for (let day = 0; day < horizonDays && out.length < count; day += 1) {
    const midnight = today + day * DAY_MS;
    for (const hour of SLOT_BANDS_IST) {
      const start = midnight + hour * HOUR_MS;
      const end = start + SLOT_BAND_HOURS * HOUR_MS;
      if (start < earliest) continue;
      if (end > latest) continue;
      // Somebody is already coming then: the publisher cannot host two agents.
      if (taken.some((t) => t.getTime() >= start && t.getTime() < end)) continue;

      out.push({
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        label: day === 0 ? 'Today' : day === 1 ? 'Tomorrow' : dateLabelIST(new Date(start)),
      });
      if (out.length >= count) break;
    }
  }
  return out;
}
