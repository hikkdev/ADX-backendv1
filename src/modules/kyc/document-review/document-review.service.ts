import type { KycDocumentDecision, KycDocumentReview, KycPartyType } from '../../../shared/database';
import { kycUserLabels, type UserLabel } from '../case-read';
import { prismaDocumentReviewRepository as repository } from './prisma-document-review.repository';

/**
 * Per-document decisions on a KYC record — Lot D (Q42/Q119).
 *
 * A review used to be one verdict over the whole record; the workbench now
 * approves or flags each tile, and a re-upload request names exactly the
 * flagged ones. The rows live here, in the one module that owns the review
 * flows, and the publisher and advertiser desks reach them through the
 * index: `publishers` for its own KYC row, `kyc/advertiser` for the twin.
 *
 * Assignment is a filter, not ownership (decision 119): nothing here checks
 * who the case is assigned to — any admin may decide.
 */

export type DocumentDecision = { field: string; decision: KycDocumentDecision; note?: string | null };

export async function recordDocumentReview(
  partyType: KycPartyType,
  kycId: string,
  input: DocumentDecision,
  reviewedById: string,
): Promise<KycDocumentReview> {
  return repository.upsert({ partyType, kycId, field: input.field, decision: input.decision, note: input.note ?? null, reviewedById });
}

/** Flags every named field in one go — the re-upload request's half. Fields already flagged keep their note unless a new one is given. */
export async function flagDocuments(
  partyType: KycPartyType,
  kycId: string,
  fields: string[],
  note: string | null,
  reviewedById: string,
): Promise<KycDocumentReview[]> {
  const existing = await repository.listFor(partyType, kycId);
  return Promise.all(
    fields.map((field) => {
      const current = existing.find((row) => row.field === field);
      return repository.upsert({
        partyType,
        kycId,
        field,
        decision: 'FLAGGED',
        note: note ?? current?.note ?? null,
        reviewedById,
      });
    }),
  );
}

export const listDocumentReviews = (partyType: KycPartyType, kycId: string) => repository.listFor(partyType, kycId);

/** E10-1: a decision with who made it — `reviewedBy { id, name }` beside `reviewedById`, through the label port. */
export type DocumentReviewWithReviewer = KycDocumentReview & { reviewedBy: UserLabel };

/**
 * E10-1: the decisions on a record with the reviewer named on each — what
 * every case read carries, so the desk prints a person and not an id. One
 * label lookup for the whole list; an id the platform no longer has is
 * `{ id, name: null }`.
 */
export async function listDocumentReviewsWithReviewer(partyType: KycPartyType, kycId: string): Promise<DocumentReviewWithReviewer[]> {
  const rows = await repository.listFor(partyType, kycId);
  const labels = await kycUserLabels(rows.map((row) => row.reviewedById));
  return rows.map((row) => ({ ...row, reviewedBy: labels.get(row.reviewedById) ?? { id: row.reviewedById, name: null } }));
}

/** The flagged fields with the reviewer's note — what a re-upload asks for and what the manifest draws. */
export async function flaggedDocuments(partyType: KycPartyType, kycId: string): Promise<{ field: string; note: string | null }[]> {
  const rows = await repository.listFor(partyType, kycId);
  return rows.filter((row) => row.decision === 'FLAGGED').map((row) => ({ field: row.field, note: row.note }));
}

/** A re-upload of a field starts it clean: whatever was decided about the old file no longer applies. */
export const clearDocumentReviews = (partyType: KycPartyType, kycId: string, fields: string[]) => repository.clear(partyType, kycId, fields);
