import type { PublisherKyc } from '../../../shared/database';

export type DigioKycFields = {
  method: 'DIGIO';
  digioRequestId: string;
  digioReferenceId: string;
  digioStatus: string;
  submittedAt: Date;
};

export type DigioWebhookUpdate = {
  digioStatus: string;
  digioPayload: unknown;
  digioVerifiedAt?: Date | undefined;
  status: 'VERIFIED' | 'REJECTED' | 'PENDING';
  reviewedAt?: Date | undefined;
  rejectionReason?: string | undefined;
};

export interface DigioRepository {
  upsertDigioKyc(publisherId: string, fields: DigioKycFields): Promise<unknown>;
  findByRequestId(kycId: string): Promise<PublisherKyc | null>;
  findByPublisherId(publisherId: string): Promise<PublisherKyc | null>;
  applyWebhook(kycRowId: string, update: DigioWebhookUpdate): Promise<unknown>;
  /** The agent to notify about a KYC outcome, plus the publisher's name. */
  findPublisherAgent(
    publisherId: string,
  ): Promise<{ id: string; name: string; agentUserId: string } | null>;
}
