import type { KycStatus, PrintPartner, PrintPartnerKyc } from '../../../shared/database';
import type { KycQueueState } from '../../../shared/kyc-state';
import type { SubmitPrintPartnerKycInput } from './print-partner-kyc.schema';

/**
 * The print partner's KYC row — Lot N. Prisma only in
 * `prisma-print-partner-kyc.repository.ts`.
 *
 * Every write that moves `status` mirrors it onto `PrintPartner.kycStatus`
 * in the same transaction, so the roster and the record never disagree.
 */

export type PrintPartnerKycRow = PrintPartnerKyc;

/** What the queue and the case carry of the partner behind the row. */
export type PartnerSlice = Pick<PrintPartner, 'id' | 'displayId' | 'name' | 'mobile' | 'email' | 'userId' | 'city' | 'isActive' | 'kycStatus' | 'createdAt'>;

export type PrintPartnerKycWithPartner = PrintPartnerKycRow & { printPartner: PartnerSlice };

/**
 * N3-B: a queue row is a PARTY — every print partner — with its derived
 * `state`, and the record's columns spread over it when it has one (every
 * column null otherwise, `kycId` null). `id` is the record's id when there
 * is one, else the partner's — either is accepted as `:id` on every desk
 * route; `printPartnerId` is always the partner's.
 */
export type PrintPartnerKycQueueRow = { [K in keyof PrintPartnerKycRow]: PrintPartnerKycRow[K] | null } & {
  id: string;
  printPartnerId: string;
  kycId: string | null;
  state: KycQueueState;
  printPartner: PartnerSlice;
};

export type PrintPartnerKycFilter = {
  /** The legacy facet — N3-B: an alias of `state` (each record status names the state of the same word). */
  status?: KycStatus;
  /** N3-B: the party's state (`shared/kyc-state`) — the queue lists every partner, in one of six. */
  state?: KycQueueState;
  /** Lot N: the desk asked and nothing has come back — `requestedAt` set, `submittedAt` null. */
  requested?: boolean;
  /** A filter, not ownership — `null` is the unassigned. */
  assignedToId?: string | null;
  escalated?: boolean;
  /** The partner's name, display id or mobile. */
  q?: string;
};

export type PrintPartnerKycSort = 'oldest' | 'newest';

/** The columns a submission writes — the documents and the two facts. */
export type PrintPartnerKycColumns = SubmitPrintPartnerKycInput;

/** Who recorded the documents, and how — SELF from the phone, DESK from the console, DIGIO from the provider. */
export type RecordedStamp = { recordedById: string; recordedVia: 'SELF' | 'DESK' | 'AGENT'; method: 'MANUAL' };

export type ReviewStamp = { reviewedById: string; reviewNote?: string | null };

export type RequestStamp = { requestedAt: Date; requestedById: string; requestedChannel: 'DIGIO' | 'MANUAL' };

export type DigioFields = {
  method: 'DIGIO';
  digioRequestId: string;
  digioReferenceId: string;
  digioStatus: string;
  /** The partner's own initiate stamps the moment; a desk request leaves it for the webhook. */
  submittedAt?: Date | undefined;
};

/**
 * What Digio's answer writes. The repository stamps `recordedVia` DIGIO with
 * no recorder, and — N2-B — `method` DIGIO when the status is VERIFIED, so a
 * record whose documents were sent by hand while the session was open is
 * Digio-verified once Digio says so (the liveness gate exempts DIGIO; the
 * purge finds it). A rejection leaves the method alone.
 */
export type DigioWebhookUpdate = {
  digioStatus: string;
  digioPayload: unknown;
  digioVerifiedAt?: Date | undefined;
  status: KycStatus;
  reviewedAt?: Date | undefined;
  rejectionReason?: string | undefined;
  submittedAt?: Date | undefined;
  recordedVia: 'DIGIO';
};

export interface PrintPartnerKycRepository {
  /** N3-B: a page of partners, left-joined to their record, in one of six states. */
  findPage(where: PrintPartnerKycFilter, page: number, pageSize: number, sort?: PrintPartnerKycSort): Promise<{ items: PrintPartnerKycQueueRow[]; total: number }>;
  /** PENDING submissions older than `cutoff`, across the whole queue — submitted rows only. */
  countBreached(where: PrintPartnerKycFilter, cutoff: Date): Promise<number>;
  /** N3-B: the chips — partners per state over the filter (the caller strips the state facet). */
  countByState(where: PrintPartnerKycFilter): Promise<Record<KycQueueState, number>>;
  countEscalated(where: PrintPartnerKycFilter): Promise<number>;
  countRequested(where: PrintPartnerKycFilter): Promise<number>;
  findById(id: string): Promise<PrintPartnerKycWithPartner | null>;
  findByPartnerId(printPartnerId: string): Promise<PrintPartnerKycWithPartner | null>;
  findByDigioRequestId(kycId: string): Promise<PrintPartnerKycWithPartner | null>;
  /** The columns the roster rows and the partner's own read carry (N2-B: `requestedChannel` too; N3-B: the record id), for a page of partners. */
  findSummaries(printPartnerIds: readonly string[]): Promise<Pick<PrintPartnerKycRow, 'id' | 'printPartnerId' | 'status' | 'submittedAt' | 'method' | 'requestedAt' | 'requestedChannel'>[]>;
  /**
   * A submission, the partner's own or the desk's: the columns sent are
   * written, the rest kept, the record goes (back) to PENDING with a fresh
   * `submittedAt`, the rejection cleared, the recorder stamped, the
   * partner's mirror moved.
   */
  submit(printPartnerId: string, data: PrintPartnerKycColumns, stamp: RecordedStamp, at: Date): Promise<PrintPartnerKycWithPartner>;
  review(id: string, status: KycStatus, rejectionReason: string | null, stamp: ReviewStamp, at: Date): Promise<PrintPartnerKycWithPartner>;
  requestReupload(id: string, stamp: ReviewStamp, at: Date): Promise<PrintPartnerKycWithPartner>;
  assign(id: string, adminUserId: string | null, at: Date): Promise<void>;
  /** The desk's ask — the row made if there is none, the request columns stamped; status untouched. */
  markRequested(printPartnerId: string, stamp: RequestStamp): Promise<PrintPartnerKycWithPartner>;
  /** A Digio session on the row — made if there is none. */
  upsertDigio(printPartnerId: string, fields: DigioFields): Promise<PrintPartnerKycWithPartner>;
  applyDigioWebhook(id: string, update: DigioWebhookUpdate): Promise<PrintPartnerKycWithPartner>;
  /** Digio-verified rows still holding images, verified before `cutoff`. */
  findPurgeable(cutoff: Date, limit: number): Promise<PrintPartnerKycRow[]>;
  purgeImages(id: string, data: { panNumber: string | null; digioPayload: unknown }): Promise<PrintPartnerKycRow>;
}
