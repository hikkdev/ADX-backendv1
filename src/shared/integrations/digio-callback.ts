/**
 * Phase D (1 Oct 2026) — what a Digio KYC callback may do to a record.
 *
 * Digio calls one webhook for every party; each party's module finds its row
 * by the request id and applies the answer. Two rules every one of them
 * follows, kept here so the five read the same:
 *
 *   - `approved` verifies, `rejected` rejects, anything else is PENDING. A
 *     workflow may send statuses the old request never did (`approval_pending`,
 *     `requested`, …); they are stored raw on `digioStatus` and read as
 *     PENDING — never dropped as unparseable.
 *   - A PENDING answer never overwrites a decision. Digio neither orders nor
 *     de-duplicates its callbacks, so a late `pending` (or an unknown status)
 *     arriving after the approval would otherwise un-verify the party — and
 *     un-verifying a publisher stops their payouts. It is logged and
 *     acknowledged, and the record is left as it is.
 */

export type DigioDecision = 'VERIFIED' | 'REJECTED' | 'PENDING';

export function digioDecisionOf(status: string | null | undefined): DigioDecision {
  const value = (status ?? '').trim().toLowerCase();
  if (value === 'approved') return 'VERIFIED';
  if (value === 'rejected') return 'REJECTED';
  return 'PENDING';
}

/** True when the answer would move a decided record back to PENDING — the caller logs it and writes nothing. */
export function isStaleDigioCallback(currentStatus: string | null | undefined, decision: DigioDecision): boolean {
  return decision === 'PENDING' && (currentStatus === 'VERIFIED' || currentStatus === 'REJECTED');
}

/**
 * Lot D (Q127): the Digio payload with every field that could carry a
 * document's contents removed: names, dates of birth, id numbers. The
 * decision and its timing stay. An unrecognised shape is dropped to null
 * rather than kept whole. The purge keeps this on a verified row; Phase D's
 * upgrade keeps it in the audit of the decision it reopens.
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
