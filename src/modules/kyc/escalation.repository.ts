import type { KycEscalationSource, KycStatus } from '../../shared/database';

/** The three KYC rows that carry escalation columns (Lot N adds the print partner's). Agent and employee KYC are recorded at ADX's own desk and have no queue to escalate from. */
export type KycEscalationParty = 'PUBLISHER' | 'ADVERTISER' | 'PRINT_PARTNER';

/** One case as the escalation sees it — the row's id, the party behind it, and where it stands. */
export type EscalatableCase = {
  party: KycEscalationParty;
  /** PublisherKyc.id, AdvertiserKyc.id or PrintPartnerKyc.id. */
  kycId: string;
  /** Publisher.id, the Advertiser profile id (N3-B — a legacy row with no profile key names its user), or PrintPartner.id. */
  partyId: string;
  partyName: string | null;
  /** The login the party notifies through; null for an agent-opened publisher who never signed in. */
  userId: string | null;
  status: KycStatus;
  submittedAt: Date | null;
  assignedToId: string | null;
  escalatedAt: Date | null;
  escalationSource: KycEscalationSource | null;
  escalationReason: string | null;
  escalatedToUserId: string | null;
  escalatedById: string | null;
  /** What the desk audits against — `Publisher` / publisherId, `AdvertiserKyc` / id, `PrintPartnerKyc` / id — so the trail reads like the desk's own rows. */
  targetType: 'Publisher' | 'AdvertiserKyc' | 'PrintPartnerKyc';
  targetId: string;
};

export type EscalationStamp = {
  escalatedAt: Date;
  escalationSource: KycEscalationSource;
  escalationReason: string;
  escalatedToUserId: string | null;
  escalatedById: string | null;
};

export interface KycEscalationRepository {
  findPublisherCase(publisherId: string): Promise<EscalatableCase | null>;
  findPublisherCaseByListing(listingId: string): Promise<EscalatableCase | null>;
  findAdvertiserCaseById(kycId: string): Promise<EscalatableCase | null>;
  /** By the Advertiser profile's id — the fraud subject — through its login. */
  findAdvertiserCaseByAdvertiserId(advertiserId: string): Promise<EscalatableCase | null>;
  /** Lot N: the print partner's row, by its own id. */
  findPrintPartnerCaseById(kycId: string): Promise<EscalatableCase | null>;
  markEscalated(party: KycEscalationParty, kycId: string, stamp: EscalationStamp): Promise<void>;
  /** PENDING, not yet escalated, submitted before `cutoff` — oldest first. */
  findAgedPending(party: KycEscalationParty, cutoff: Date, limit: number): Promise<EscalatableCase[]>;
  /** Every ADMIN login — the last fallback for the escalation pool. */
  adminUserIds(): Promise<string[]>;
}
