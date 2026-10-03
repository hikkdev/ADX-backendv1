/**
 * Lot D (Q127): what a purge keeps.
 *
 * A Digio-verified record loses its images thirty days after verification;
 * what stays is the proof that Digio verified it — the request and reference
 * ids, the status, when — a payload trimmed to the decision, and the last
 * four of the PAN so a later query can still say "the PAN ending 1234 was
 * verified on this date" without holding the number.
 */
export const PURGE_AFTER_DAYS = 30;

export function purgeCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000);
}

/** `ABCDE1234F` → `******234F`. Null stays null. */
export function maskPan(pan: string | null | undefined): string | null {
  if (!pan) return null;
  const tail = pan.slice(-4);
  return `${'*'.repeat(Math.max(0, pan.length - 4))}${tail}`;
}

/**
 * The Digio payload trimmed to the decision — Phase D moved it beside the
 * callback rules in `shared/integrations/digio-callback.ts`, where the
 * upgrade's audit (three modules) reads it too; re-exported for the purge.
 */
export { trimDigioPayload } from '../../shared/integrations/digio-callback';
