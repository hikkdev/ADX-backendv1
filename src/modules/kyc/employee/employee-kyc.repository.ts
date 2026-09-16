import type { EmployeeKyc, KycStatus } from '../../../shared/database';
import type { KycQueueState } from '../../../shared/kyc-state';
import type { EmployeeKycDocuments } from './employee-kyc.schema';

export type EmployeeKycFilter = {
  /** The legacy facet — N3-B: an alias of `state` (each record status names the state of the same word). */
  status?: KycStatus;
  /** N3-B: the party's state (`shared/kyc-state`). */
  state?: KycQueueState;
  /** N3-B: the employee's name, display id, email or mobile contains. */
  q?: string;
};

/** What the queue and the case carry of the employee behind the row. */
export type EmployeeSlice = {
  id: string;
  userId: string;
  displayId: string | null;
  department: string | null;
  designation: string | null;
  createdAt: Date;
  user: { name: string | null; mobile: string; email: string | null };
};

/** A record with the employee it belongs to — what the case read answers. */
export type EmployeeKycRow = EmployeeKyc & { employee: EmployeeSlice };

/**
 * N3-B: a queue row is a PARTY — every Employee — with its derived `state`,
 * and the record's columns spread over it when it has one (every column
 * null otherwise, `kycId` null). `id` is the record's id when there is one,
 * else the employee's; `employeeId` is always the employee's, which is what
 * every `/employee-kyc/:employeeId` route takes.
 */
export type EmployeeKycQueueRow = { [K in keyof EmployeeKyc]: EmployeeKyc[K] | null } & {
  id: string;
  employeeId: string;
  kycId: string | null;
  state: KycQueueState;
  employee: EmployeeSlice;
};

/** N3-B: who the desk's request reaches — the employee is an individual with a user. */
export type EmployeeContact = { id: string; userId: string; displayId: string | null; user: { name: string | null; email: string | null; mobile: string } };

export type EmployeeKycRequestStamp = { requestedById: string; requestedChannel: 'DIGIO' | 'MANUAL'; at: Date };

export type EmployeeDigioFields = { method: 'DIGIO'; digioRequestId: string; digioReferenceId: string; digioStatus: string };

/** What Digio's answer writes; `method` DIGIO is stamped on a VERIFIED answer, `submittedAt` where it was null. */
export type EmployeeDigioUpdate = {
  digioStatus: string;
  digioPayload: unknown;
  digioVerifiedAt?: Date | undefined;
  status: KycStatus;
  reviewedAt?: Date | undefined;
  rejectionReason?: string | undefined;
  submittedAt: Date;
};

export interface EmployeeKycRepository {
  /** N3-B: a page of employees, left-joined to their record, in one of six states; awaiting-documents rows by when the employee arrived. */
  findPage(where: EmployeeKycFilter, page: number, pageSize: number): Promise<{ items: EmployeeKycQueueRow[]; total: number }>;
  /** N3-B: the chips — employees per state over the filter (the caller strips the state facet). */
  countByState(where: EmployeeKycFilter): Promise<Record<KycQueueState, number>>;
  findByEmployeeId(employeeId: string): Promise<EmployeeKycRow | null>;
  /** N3-B: the employee behind an id, with the contact the request reaches; null when there is no such employee. */
  findEmployeeContact(employeeId: string): Promise<EmployeeContact | null>;
  /** Create or replace the documents; the record goes (back) to PENDING. */
  record(employeeId: string, data: EmployeeKycDocuments, recordedById: string): Promise<EmployeeKycRow>;
  review(employeeId: string, status: KycStatus, rejectionReason: string | null, reviewedById: string): Promise<EmployeeKycRow>;
  /** N3-B: the desk asked — an upsert on the employee's row; the status untouched (REQUESTED is derived). */
  requestKyc(employeeId: string, stamp: EmployeeKycRequestStamp): Promise<EmployeeKycRow>;
  /** N3-B: a Digio session on the employee's row — made if there is none; `submittedAt` waits for the webhook. */
  upsertDigio(employeeId: string, fields: EmployeeDigioFields): Promise<EmployeeKycRow>;
  findByDigioRequestId(kycId: string): Promise<EmployeeKycRow | null>;
  applyDigioWebhook(id: string, update: EmployeeDigioUpdate): Promise<EmployeeKycRow>;
}
