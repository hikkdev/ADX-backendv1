import type { FraudCase, FraudCaseEvidence, FraudCaseNote, FraudCaseStatus, SuspendedPartyType, SuspensionScope } from '../../shared/database';
import type { ListPage } from '../../shared/pagination';
import type { ListCasesQuery } from './fraud.schema';
import type { StoredSignal } from './signals/types';

export type NewFraudCase = {
  /** E6: minted by the service through `identifiers` (FRAUD_CASE, prefix FRD). */
  displayId: string;
  subjectType: SuspendedPartyType;
  subjectId: string;
  kind: string;
  summary: string;
  openedByUserId: string;
  assignedToUserId: string | null;
  disputeId: string | null;
  /** Lot G: the scan opens a case already scored. */
  score?: string | null;
  signals?: StoredSignal[] | null;
  scoredAt?: Date | null;
};

export type FraudCasePatch = Partial<{
  status: FraudCaseStatus;
  assignedToUserId: string | null;
  decision: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  /** E6: what the confirmation applied, on the row (Lot E column). */
  appliedScopes: SuspensionScope[];
  /** Lot G (Q118/138): the explainable score, the signals behind it, and when. */
  score: string | null;
  signals: StoredSignal[] | null;
  scoredAt: Date | null;
  /** Lot G (Q118): the escalation. */
  escalatedAt: Date | null;
  escalatedToUserId: string | null;
  escalationNote: string | null;
}>;

export type FraudCaseFile = FraudCase & {
  notes: FraudCaseNote[];
  evidence: FraudCaseEvidence[];
};

/** What a dispute reads: the open case citing it. */
export type OpenFraudCaseRef = Pick<FraudCase, 'id' | 'displayId' | 'status' | 'disputeId'>;

export interface FraudRepository {
  list(query: ListCasesQuery): Promise<ListPage<FraudCase>>;
  findById(caseId: string): Promise<FraudCaseFile | null>;
  /** Without the notes and evidence — for the checks before a write. */
  findSummaryById(caseId: string): Promise<FraudCase | null>;
  /**
   * Writes the case with its FRD- number minted inside — a per-year counter
   * over this table, because the identifiers module's `PartyType` has no
   * FRAUD_CASE series yet. Retries on a collision; the unique on `displayId`
   * is the backstop.
   */
  create(data: NewFraudCase, now: Date): Promise<FraudCase>;
  update(caseId: string, patch: FraudCasePatch): Promise<FraudCase>;
  addNote(data: { caseId: string; byUserId: string; body: string }): Promise<FraudCaseNote>;
  addEvidence(data: {
    caseId: string;
    kind: string;
    fileId: string | null;
    url: string | null;
    note: string | null;
    addedByUserId: string;
  }): Promise<FraudCaseEvidence>;
  /** Open (OPEN, INVESTIGATING, ESCALATED) cases citing any of these disputes. */
  findOpenForDisputes(disputeIds: string[]): Promise<OpenFraudCaseRef[]>;
  /** Lot G: the open case against a party, if any — what stops the scan opening a second. */
  findOpenForSubject(subjectType: SuspendedPartyType, subjectId: string): Promise<FraudCase | null>;
}
