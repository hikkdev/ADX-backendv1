import type { FraudSignal, LinkedParty, OnboardedPublisher } from './types';

export const REJECTED_SHARE_CEILING = 0.4;
export const IDLE_AFTER_DAYS = 60;
/** Fewer publishers than this and the rates mean nothing. */
export const MIN_ONBOARDED = 3;

export function farmingRates(publishers: OnboardedPublisher[], now: Date): { rejectedShare: number; idleShare: number; matured: number } {
  const total = publishers.length;
  const rejected = publishers.filter((p) => p.kycStatus === 'REJECTED').length;
  const cutoff = now.getTime() - IDLE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const maturedRows = publishers.filter((p) => p.createdAt.getTime() <= cutoff);
  const idle = maturedRows.filter((p) => p.bookings === 0).length;
  return {
    rejectedShare: total ? rejected / total : 0,
    idleShare: maturedRows.length ? idle / maturedRows.length : 0,
    matured: maturedRows.length,
  };
}

/** An agent whose publishers are mostly rejected at KYC, or mostly never book — onboarding bodies for the commission. */
export const commissionFarmingSignal: FraudSignal = {
  key: 'COMMISSION_FARMING',
  weight: 0.3,
  async evaluate(subject, { index, now }) {
    if (subject.type !== 'AGENT') return { value: 0, detail: 'Only an agent earns onboarding commission.' };
    const publishers = await index.onboardedPublishersOf(subject.id);
    // G13-B: the publishers judged are the candidates — the registry caps what is stored.
    const candidates: LinkedParty[] = publishers.map((p) => ({ type: 'PUBLISHER', id: p.id, name: p.name ?? null }));
    if (publishers.length < MIN_ONBOARDED) return { value: 0, detail: `Fewer than ${MIN_ONBOARDED} publishers onboarded; nothing to judge.`, candidates };
    const { rejectedShare, idleShare, matured } = farmingRates(publishers, now);
    const rejectedHigh = rejectedShare > REJECTED_SHARE_CEILING;
    const idleHigh = matured >= MIN_ONBOARDED && idleShare > 0.5;
    const summary = `${Math.round(rejectedShare * 100)}% of ${publishers.length} onboarded publishers rejected at KYC; ${Math.round(idleShare * 100)}% of ${matured} older than ${IDLE_AFTER_DAYS} days never received a booking.`;
    if (!rejectedHigh && !idleHigh) return { value: 0, detail: summary, candidates };
    return { value: 1, detail: summary, candidates };
  },
};
