import type { FraudSignal } from './types';

export const RATE_CEILING = 0.3;
export const OUTCOME_WINDOW_DAYS = 90;
export const MIN_BOOKINGS = 3;

/** Refunds and disputes against bookings — over 30 % is not bad luck. */
export const refundDisputeRateSignal: FraudSignal = {
  key: 'REFUND_DISPUTE_RATE',
  weight: 0.25,
  async evaluate(subject, { index, now }) {
    if (subject.type === 'AGENT') return { value: 0, detail: 'An agent has no bookings of their own.' };
    const since = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const { bookings, refunds, disputes } = await index.bookingOutcomesFor(subject, since);
    if (bookings < MIN_BOOKINGS) return { value: 0, detail: `${bookings} bookings in ${OUTCOME_WINDOW_DAYS} days; too few to judge.` };
    const rate = (refunds + disputes) / bookings;
    const pct = Math.round(rate * 100);
    if (rate <= RATE_CEILING) return { value: 0, detail: `${refunds} refunds and ${disputes} disputes over ${bookings} bookings (${pct}%).` };
    return { value: 1, detail: `${refunds} refunds and ${disputes} disputes over ${bookings} bookings (${pct}%, ceiling ${RATE_CEILING * 100}%).` };
  },
};
