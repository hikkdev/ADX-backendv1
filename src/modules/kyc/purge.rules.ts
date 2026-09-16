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
 * The Digio payload with every field that could carry a document's contents
 * removed: names, dates of birth, id numbers. The decision and its timing
 * stay. An unrecognised shape is dropped to null rather than kept whole.
 */
export function trimDigioPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return null;
  const source = payload as Record<string, unknown>;
  const documents = Array.isArray(source['kyc_documents'])
    ? (source['kyc_documents'] as Record<string, unknown>[]).map((doc) => ({
        type: typeof doc['type'] === 'string' ? doc['type'] : null,
        status: typeof doc['status'] === 'string' ? doc['status'] : null,
      }))
    : undefined;
  return {
    id: typeof source['id'] === 'string' ? source['id'] : null,
    status: typeof source['status'] === 'string' ? source['status'] : null,
    completed_at: typeof source['completed_at'] === 'string' ? source['completed_at'] : null,
    ...(documents ? { kyc_documents: documents } : {}),
    trimmed: true,
  };
}
