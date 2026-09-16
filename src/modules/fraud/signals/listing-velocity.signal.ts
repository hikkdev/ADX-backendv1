import type { FraudSignal } from './types';

export const VELOCITY_WINDOW_MS = 10 * 60 * 1000;
export const VELOCITY_CEILING = 10;
export const VELOCITY_LOOKBACK_DAYS = 30;

/** The largest number of listings created inside any ten-minute window. */
export function peakInWindow(createdAt: Date[], windowMs = VELOCITY_WINDOW_MS): number {
  const times = createdAt.map((d) => d.getTime()).sort((a, b) => a - b);
  let peak = 0;
  let start = 0;
  for (let end = 0; end < times.length; end += 1) {
    while ((times[end] ?? 0) - (times[start] ?? 0) > windowMs) start += 1;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

/** More than ten listings in ten minutes — a script, or a book being pasted in to be "verified" later. */
export const listingVelocitySignal: FraudSignal = {
  key: 'LISTING_VELOCITY',
  weight: 0.2,
  async evaluate(subject, { index, now }) {
    if (subject.type !== 'PUBLISHER') return { value: 0, detail: 'Only a publisher creates listings.' };
    const since = new Date(now.getTime() - VELOCITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const created = await index.listingCreatedAtFor(subject.id, since);
    const peak = peakInWindow(created);
    if (peak <= VELOCITY_CEILING) return { value: 0, detail: `At most ${peak} listings in any ten minutes over ${VELOCITY_LOOKBACK_DAYS} days.` };
    return { value: 1, detail: `${peak} listings created inside ten minutes (ceiling ${VELOCITY_CEILING}).` };
  },
};
