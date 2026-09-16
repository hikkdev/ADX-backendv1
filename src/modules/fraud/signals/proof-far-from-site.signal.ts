import { haversineMeters } from '../../../shared/geo';
import type { FraudSignal, ProofPhoto } from './types';

export const PROOF_MAX_DISTANCE_M = 500;
export const PROOF_WINDOW_DAYS = 90;
/** A day either side of the flight: an install the evening before is honest. */
export const SLOT_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export type ProofVerdict = { far: boolean; outsideSlot: boolean; distanceM: number | null };

export function judgeProof(proof: ProofPhoto): ProofVerdict {
  const distanceM =
    proof.latitude !== null && proof.longitude !== null && proof.listingLatitude !== null && proof.listingLongitude !== null
      ? haversineMeters(proof.latitude, proof.longitude, proof.listingLatitude, proof.listingLongitude)
      : null;
  const far = distanceM !== null && distanceM > PROOF_MAX_DISTANCE_M;
  const at = proof.capturedAt.getTime();
  const outsideSlot =
    (proof.slotStart !== null && at < proof.slotStart.getTime() - SLOT_TOLERANCE_MS) ||
    (proof.slotEnd !== null && at > proof.slotEnd.getTime() + SLOT_TOLERANCE_MS);
  return { far, outsideSlot, distanceM };
}

/** Installation proofs taken far from the listing, or outside the booking's window — the share of proofs that are wrong. */
export const proofFarFromSiteSignal: FraudSignal = {
  key: 'PROOF_FAR_FROM_SITE',
  weight: 0.3,
  async evaluate(subject, { index, now }) {
    if (subject.type !== 'PUBLISHER') return { value: 0, detail: 'Only a publisher has installation proofs.' };
    const since = new Date(now.getTime() - PROOF_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const proofs = await index.proofPhotosFor(subject.id, since);
    if (proofs.length === 0) return { value: 0, detail: `No installation proofs in ${PROOF_WINDOW_DAYS} days.` };
    const verdicts = proofs.map(judgeProof);
    const far = verdicts.filter((v) => v.far).length;
    const outside = verdicts.filter((v) => v.outsideSlot).length;
    const bad = verdicts.filter((v) => v.far || v.outsideSlot).length;
    if (bad === 0) return { value: 0, detail: `All ${proofs.length} proofs within ${PROOF_MAX_DISTANCE_M} m and inside the booking window.` };
    return {
      value: Math.round((bad / proofs.length) * 1000) / 1000,
      detail: `${bad} of ${proofs.length} proofs wrong: ${far} taken over ${PROOF_MAX_DISTANCE_M} m from the site, ${outside} outside the booking window.`,
    };
  },
};
