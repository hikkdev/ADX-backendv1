import type {
  KycStatus,
  Publisher,
  PublisherKyc,
  PublisherType,
} from '../../shared/database';

export type NewPublisher = {
  agentId: string;
  name: string;
  mobile: string;
  email?: string;
  type?: PublisherType;
  city?: string;
  state?: string;
};

export type PublisherPatch = Partial<{
  name: string;
  email: string;
  type: PublisherType;
  city: string;
  state: string;
}>;

export type KycDocuments = Partial<{
  aadhaarFrontUrl: string;
  aadhaarBackUrl: string;
  panFrontUrl: string;
  panBackUrl: string;
  gstUrl: string;
  addressProofUrl: string;
  bankStatement: string;
  businessRegCertUrl: string;
  directorIdUrl: string;
  businessAddressProofUrl: string;
  adAuthLetterUrl: string;
  ngoRegCertUrl: string;
  ngoAddressProofUrl: string;
  ngoTaxExemptionCertUrl: string;
  ngoOperationalOverviewUrl: string;
}>;

/** Publisher with the joins the agent-facing endpoints return. */
export type PublisherWithDetail = Publisher & { kyc: PublisherKyc | null; listings: unknown[] };

export interface PublishersRepository {
  create(data: NewPublisher): Promise<PublisherWithDetail>;
  findForAgent(agentId: string, category?: string): Promise<PublisherWithDetail[]>;
  findById(publisherId: string): Promise<PublisherWithDetail | null>;
  /** Without joins — for ownership and state checks. */
  findSummaryById(publisherId: string): Promise<Publisher | null>;
  findByUserId(userId: string): Promise<Publisher | null>;
  findByUserIdWithKyc(userId: string): Promise<(Publisher & { kyc: PublisherKyc | null }) | null>;
  update(publisherId: string, data: PublisherPatch): Promise<PublisherWithDetail>;

  /** Upserts the KYC row and mirrors the status onto the publisher, atomically. */
  submitKyc(publisherId: string, docs: KycDocuments): Promise<PublisherKyc>;
  reviewKyc(
    publisherId: string,
    status: KycStatus,
    rejectionReason?: string,
  ): Promise<PublisherKyc>;

  // ── Self-registration and onboarding ──
  createSelfRegistered(data: {
    userId: string;
    name: string;
    mobile: string;
    email?: string;
  }): Promise<Publisher>;
  setUserProfile(userId: string, name: string, email?: string): Promise<unknown>;
  findUserMobile(userId: string): Promise<{ mobile: string } | null>;
  claim(publisherId: string, agentId: string): Promise<unknown>;
  /** Publisher state only — expiring its QR codes is the qr module's job. */
  resetOnboardingState(publisherId: string): Promise<unknown>;
  completeOnboarding(publisherId: string): Promise<unknown>;
}
