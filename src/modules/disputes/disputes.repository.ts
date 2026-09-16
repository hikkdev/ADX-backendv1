import type { Dispute, DisputeEvidence, DisputeMessage } from '../../shared/database';
import type {
  DisputePatch,
  DisputeSummary,
  NewDispute,
  NewEvidence,
  NewMessage,
  OrderParties,
  PartyIds,
  QueueFilter,
} from './disputes.types';

/** The order as a case card shows it. */
export type DisputeOrderCard = {
  id: string;
  status: string;
  campaignName: string | null;
  listing: { id: string; title: string; address: string; city: string | null } | null;
};

export type DisputeRow = Dispute & {
  order: DisputeOrderCard | null;
  _count: { messages: number; evidence: number };
};

export type DisputeDetail = Dispute & {
  order: DisputeOrderCard | null;
  raisedBy: { id: string; name: string | null };
  messages: DisputeMessage[];
  evidence: DisputeEvidence[];
};

export interface DisputesRepository {
  /** Every case the person is a party to — raised by them or against them — newest activity first. */
  findManyForUser(userId: string): Promise<DisputeRow[]>;
  findById(disputeId: string): Promise<DisputeDetail | null>;
  /** Without the thread — used for authorisation before a write. */
  findSummaryById(disputeId: string): Promise<Dispute | null>;
  create(data: NewDispute): Promise<Dispute>;
  update(disputeId: string, data: DisputePatch): Promise<Dispute>;
  /** Creates the message and touches the case in one transaction. */
  addMessage(data: NewMessage): Promise<DisputeMessage>;
  addEvidence(data: NewEvidence): Promise<DisputeEvidence>;
  /**
   * E9: the evidence rows whose URL could name this file — a contains
   * prefilter; the service matches the id exactly and resolves each row's
   * own case by `disputeId`, never by the URL text across cases.
   */
  findEvidenceByFileId(fileId: string): Promise<{ disputeId: string; url: string }[]>;
  /** E9: the two people of each named case — for the file door. */
  findPartiesByDisputeIds(disputeIds: readonly string[]): Promise<{ id: string; raisedByUserId: string; againstUserId: string | null }[]>;

  /* ── The desk ─────────────────────────────────────────────────── */
  findQueue(filter: QueueFilter): Promise<DisputeRow[]>;
  /** E6: the list contract's total and per-status chips, counted with the status facet removed. */
  countQueue(filter: Pick<QueueFilter, 'status' | 'q'>): Promise<{ total: number; counts: Record<string, number> }>;
  summary(now: Date): Promise<DisputeSummary>;

  /* ── What the raise needs from other tables ───────────────────── */
  findOrderParties(orderId: string): Promise<OrderParties | null>;
  partyIdsForUser(userId: string): Promise<PartyIds>;
}
