import type { AgentKyc, KycStatus } from '../../../shared/database';
import type { KycQueueState } from '../../../shared/kyc-state';
import type { AgentKycDocuments } from './agent-kyc.schema';

export type AgentKycFilter = {
  /** The legacy facet — N3-B: an alias of `state` (each record status names the state of the same word). */
  status?: KycStatus;
  /** N3-B: the party's state (`shared/kyc-state`). */
  state?: KycQueueState;
  /** N3-B: the agent's name, display id or mobile contains. */
  q?: string;
};

/** What the queue and the case carry of the agent behind the row. */
export type AgentSlice = { id: string; userId: string; displayId: string | null; city: string | null; createdAt: Date; user: { name: string | null; mobile: string; email: string | null } };

/** A record with the agent it belongs to — what the case read answers. */
export type AgentKycRow = AgentKyc & { agent: AgentSlice };

/**
 * N3-B: a queue row is a PARTY — every AgentProfile — with its derived
 * `state`, and the record's columns spread over it when it has one (every
 * column null otherwise, `kycId` null). `id` is the record's id when there is
 * one, else the agent's; `agentId` is always the agent's, which is what
 * every `/agent-kyc/:agentId` route takes.
 */
export type AgentKycQueueRow = { [K in keyof AgentKyc]: AgentKyc[K] | null } & {
  id: string;
  agentId: string;
  kycId: string | null;
  state: KycQueueState;
  agent: AgentSlice;
};

/** N3-B: who the desk's request reaches — the agent is an individual with a user. */
export type AgentContact = { id: string; userId: string; displayId: string | null; user: { name: string | null; email: string | null; mobile: string } };

export type AgentKycRequestStamp = { requestedById: string; requestedChannel: 'DIGIO' | 'MANUAL'; at: Date };

export type AgentDigioFields = { method: 'DIGIO'; digioRequestId: string; digioReferenceId: string; digioStatus: string };

/** What Digio's answer writes; `method` DIGIO is stamped on a VERIFIED answer, `submittedAt` where it was null. */
export type AgentDigioUpdate = {
  digioStatus: string;
  digioPayload: unknown;
  digioVerifiedAt?: Date | undefined;
  status: KycStatus;
  reviewedAt?: Date | undefined;
  rejectionReason?: string | undefined;
  submittedAt: Date;
};

export interface AgentKycRepository {
  /** N3-B: a page of agents, left-joined to their record, in one of six states; awaiting-documents rows by when the agent arrived. */
  findPage(where: AgentKycFilter, page: number, pageSize: number): Promise<{ items: AgentKycQueueRow[]; total: number }>;
  /** N3-B: the chips — agents per state over the filter (the caller strips the state facet). */
  countByState(where: AgentKycFilter): Promise<Record<KycQueueState, number>>;
  findByAgentId(agentId: string): Promise<AgentKycRow | null>;
  /** N3-B: the agent behind an id, with the contact the request reaches; null when there is no such agent. */
  findAgentContact(agentId: string): Promise<AgentContact | null>;
  /** Create or replace the documents; the record goes (back) to PENDING. */
  record(agentId: string, data: AgentKycDocuments, recordedById: string): Promise<AgentKycRow>;
  review(agentId: string, status: KycStatus, rejectionReason: string | null, reviewedById: string): Promise<AgentKycRow>;
  /** N3-B: the desk asked — an upsert on the agent's row; the status untouched (REQUESTED is derived). */
  requestKyc(agentId: string, stamp: AgentKycRequestStamp): Promise<AgentKycRow>;
  /** N3-B: a Digio session on the agent's row — made if there is none; `submittedAt` waits for the webhook. */
  upsertDigio(agentId: string, fields: AgentDigioFields): Promise<AgentKycRow>;
  findByDigioRequestId(kycId: string): Promise<AgentKycRow | null>;
  applyDigioWebhook(id: string, update: AgentDigioUpdate): Promise<AgentKycRow>;
}
