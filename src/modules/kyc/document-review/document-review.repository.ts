import type { KycDocumentDecision, KycDocumentReview, KycPartyType } from '../../../shared/database';

/** One decision on one document of one KYC record — unique per (party, record, field). */
export type DocumentReviewInput = {
  partyType: KycPartyType;
  kycId: string;
  field: string;
  decision: KycDocumentDecision;
  note?: string | null;
  reviewedById: string;
};

export interface DocumentReviewRepository {
  upsert(input: DocumentReviewInput): Promise<KycDocumentReview>;
  /** Every decision on a record, oldest first. */
  listFor(partyType: KycPartyType, kycId: string): Promise<KycDocumentReview[]>;
  /** Drops the decisions on the named fields — a re-upload starts them clean. Returns how many went. */
  clear(partyType: KycPartyType, kycId: string, fields: string[]): Promise<number>;
}
