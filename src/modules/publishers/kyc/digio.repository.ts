import type { KycEntityType, PublisherKyc } from '../../../shared/database';

export type DigioKycFields = {
  /** Cashfree Phase 1: CASHFREE when the start was handed a Cashfree session — the request id is then `cf_<sessionId>`. */
  method: 'DIGIO' | 'CASHFREE';
  digioRequestId: string;
  digioReferenceId: string;
  digioStatus: string;
  submittedAt: Date;
};

/**
 * What Digio's answer writes. The repository stamps `recordedVia` DIGIO with
 * no recorder, and — N2-B — `method` DIGIO when the status is VERIFIED, so a
 * record whose documents were sent by hand while the session was open is
 * Digio-verified once Digio says so (the liveness gate exempts DIGIO; the
 * purge finds it). A rejection leaves the method alone.
 */
export type DigioWebhookUpdate = {
  /** Cashfree Phase 1: who answered — stamped on `recordedVia`, and on `method` when the answer verifies. DIGIO when absent. */
  via?: 'DIGIO' | 'CASHFREE' | undefined;
  digioStatus: string;
  digioPayload: unknown;
  digioVerifiedAt?: Date | undefined;
  status: 'VERIFIED' | 'REJECTED' | 'PENDING';
  reviewedAt?: Date | undefined;
  rejectionReason?: string | undefined;
};

export interface DigioRepository {
  upsertDigioKyc(publisherId: string, fields: DigioKycFields): Promise<unknown>;
  /** Phase D: the legal form the publisher verifies as, stored on their row. */
  setEntityType(publisherId: string, entityType: KycEntityType): Promise<unknown>;
  /**
   * Phase D, the upgrade: a verified individual verifying again as a
   * business — the new entity type on the row, and the record and the mirror
   * back to PENDING on the fresh Digio request, the old decision cleared, in
   * one transaction.
   */
  restartForUpgrade(publisherId: string, entityType: KycEntityType, fields: DigioKycFields): Promise<unknown>;
  /**
   * Cashfree Phase 1: Digio could not be asked and the desk may send the
   * backup — the record says PROVIDER_FAILED on its raw provider status
   * (made if there is none). Nothing else on the record moves.
   */
  markProviderFailed(publisherId: string): Promise<unknown>;
  findByRequestId(kycId: string): Promise<PublisherKyc | null>;
  findByPublisherId(publisherId: string): Promise<PublisherKyc | null>;
  /** Phase D: the record and the publisher's `kycStatus` mirror, in one transaction. */
  applyWebhook(kyc: Pick<PublisherKyc, 'id' | 'publisherId'>, update: DigioWebhookUpdate): Promise<unknown>;
  /** The agent to notify about a KYC outcome, plus the publisher's name. */
  findPublisherAgent(
    publisherId: string,
  ): Promise<{ id: string; name: string; agentUserId: string } | null>;
}
