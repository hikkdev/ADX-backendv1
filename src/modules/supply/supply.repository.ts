import type {
  AgreementAcceptance,
  AgreementKind,
  AgreementTemplate,
  ComplianceCase,
  ComplianceCaseStatus,
  ContactAttemptChannel,
  Listing,
  ListingAttempt,
  ListingAttemptOrigin,
  ListingAttemptStatus,
  ListingClaim,
  ListingClaimStatus,
  ListingDocument,
  ListingDocumentKind,
  ListingDocumentStatus,
  ListingRemovability,
  ListingVerification,
  VerificationStatus,
  VerificationType,
} from '../../shared/database';
import type { Page, PageQuery } from '../../shared/pagination';

/* ------------------------------------------------------------------ */
/* Funnel                                                              */
/* ------------------------------------------------------------------ */

/**
 * The five supply gates, counted. `stuckOnPublisher` and `stuckOnAdx` split the
 * same population by who is being waited on, which is the question ops actually
 * asks — see docs/publisher-supply-lifecycle.md.
 */
export type SupplyFunnel = {
  accountsCreated: number;
  kycVerified: number;
  platformAgreementAccepted: number;
  withInventory: number;
  listingAgreementAccepted: number;
  listingsLive: number;
  stuckOnPublisher: { awaitingAgreement: number; awaitingDocuments: number };
  stuckOnAdx: { pendingDocumentReview: number; awaitingSiteVerification: number };
};

/** A publisher row with the gate states the activation funnel renders. */
export type PublisherFunnelRow = {
  id: string;
  name: string;
  city: string | null;
  isPartnerPublisher: boolean;
  kycStatus: string;
  platformAgreementAcceptedAt: Date | null;
  activatedAt: Date | null;
  listingCount: number;
  liveListingCount: number;
  createdAt: Date;
};

/* ------------------------------------------------------------------ */
/* Attempts                                                            */
/* ------------------------------------------------------------------ */

export type NewListingAttempt = {
  publisherId?: string | null;
  origin: ListingAttemptOrigin;
  createdByUserId?: string | null;
  sourceFilename?: string | null;
  note?: string | null;
};

/** One row of an imported spreadsheet, already validated by the caller. */
export type AttemptListingInput = {
  title: string;
  address: string;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  category: Listing['category'];
  subType?: string | null;
  size?: string | null;
  monthlyPrice?: number;
  ratePerDay?: string;
  sizeClassId?: string | null;
  sizeClassSlug?: string;
  materialId?: string | null;
  mediaTypeId?: string | null;
  materialSlug?: string;
  mediaTypeName?: string;
  removability?: ListingRemovability;
};

/** An import row after the service has classified and priced it. */
export type ResolvedAttemptListing = Omit<
  AttemptListingInput,
  'mediaTypeName' | 'sizeClassSlug' | 'materialSlug'
> & {
  ratePerDay: string;
  ratePerDaySurgeUntil: Date | null;
  /** Lot X-B: the `City` row `city` denotes, or null for a typed town — resolved once per batch. */
  cityId: string | null;
};

export type AttemptWithListings = ListingAttempt & {
  listings: Listing[];
  acceptance: AgreementAcceptance | null;
  /** True size of the batch. `listings` may be capped — see `findAttempt`. */
  _count: { listings: number };
};

/** Per-attempt document progress, the number the chase queue is built on. */
export type AttemptProgress = {
  attemptId: string;
  listingCount: number;
  documentsCleared: number;
  documentsRejected: number;
  awaitingSiteVerification: number;
  live: number;
};

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

export type NewVerification = {
  listingId: string;
  type: VerificationType;
  /** The first of `photos`, denormalised so single-photo readers are unchanged. */
  photoUrl: string;
  /** Every named shot from the visit, in the order the agent was walked through. */
  photos: { url: string; label: string | null; order: number }[];
  latitude: number;
  longitude: number;
  distanceMeters?: number | null;
  qrScanned?: boolean;
  capturedAt: Date;
  submittedByUserId?: string | null;
  orderId?: string | null;
};

/** A verification with its named shots, which is what a reviewer needs to see. */
export type VerificationWithPhotos = ListingVerification & {
  photos: { id: string; url: string; label: string | null; order: number }[];
};

/** A listing whose verification is due, in the risk window, or lapsed. */
export type VerificationDueRow = {
  listingId: string;
  title: string;
  publisherId: string | null;
  publisherName: string | null;
  removability: ListingRemovability;
  verifiedAt: Date | null;
  verificationExpiresAt: Date | null;
  status: Listing['status'];
};

/* ------------------------------------------------------------------ */
/* Repository                                                          */
/* ------------------------------------------------------------------ */

export interface SupplyRepository {
  /* Funnel */
  funnel(): Promise<SupplyFunnel>;
  publisherFunnelRows(limit: number, offset: number): Promise<PublisherFunnelRow[]>;

  /* Agreement templates — read only; the lifecycle is `agreements`' (Lot D). */
  activeTemplate(kind: AgreementKind): Promise<AgreementTemplate | null>;

  /* Acceptances */
  findAcceptance(publisherId: string, templateId: string): Promise<AgreementAcceptance | null>;
  findPlatformAcceptance(publisherId: string): Promise<AgreementAcceptance | null>;
  createAcceptance(data: {
    templateId: string;
    templateKind: AgreementKind;
    templateVersion: number;
    publisherId: string;
    attemptId?: string | null;
    acceptedByUserId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    renderedDocument?: string | null;
  }): Promise<AgreementAcceptance>;
  markPublisherActivated(publisherId: string): Promise<void>;

  /* Attempts */
  createAttempt(data: NewListingAttempt): Promise<ListingAttempt>;
  findAttempt(attemptId: string): Promise<AttemptWithListings | null>;
  listAttempts(
    filter: { status?: ListingAttemptStatus; publisherId?: string; origin?: ListingAttemptOrigin },
    page?: PageQuery,
  ): Promise<Page<AttemptWithListings>>;
  setAttemptStatus(attemptId: string, status: ListingAttemptStatus): Promise<ListingAttempt>;
  addListingsToAttempt(attemptId: string, rows: ResolvedAttemptListing[]): Promise<number>;
  attemptProgress(attemptId: string): Promise<AttemptProgress>;
  /** Move every listing on an accepted attempt off AWAITING_AGREEMENT. */
  advanceAttemptListings(attemptId: string): Promise<number>;

  /* Documents */
  addDocument(data: {
    listingId: string;
    kind: ListingDocumentKind;
    url: string;
  }): Promise<ListingDocument>;
  findDocument(documentId: string): Promise<ListingDocument | null>;
  reviewDocument(
    documentId: string,
    data: { status: ListingDocumentStatus; rejectionReason?: string | null; reviewedByUserId: string },
  ): Promise<ListingDocument>;
  listDocuments(listingId: string): Promise<ListingDocument[]>;
  /** True when the listing has at least one document and none are outstanding. */
  documentsCleared(listingId: string): Promise<boolean>;

  /* Verification */
  createVerification(data: NewVerification): Promise<ListingVerification>;
  findVerification(verificationId: string): Promise<ListingVerification | null>;
  reviewVerification(
    verificationId: string,
    data: { status: VerificationStatus; rejectionReason?: string | null; reviewedByUserId: string },
  ): Promise<ListingVerification>;
  listVerifications(listingId: string): Promise<VerificationWithPhotos[]>;
  /** Bounded per call: the sweep works in batches rather than one huge set. */
  verificationsDue(before: Date, limit?: number): Promise<VerificationDueRow[]>;

  /* Listings */
  findListing(listingId: string): Promise<Listing | null>;
  setListingStatus(listingId: string, status: Listing['status']): Promise<Listing>;
  markListingVerified(
    listingId: string,
    data: { verifiedAt: Date; verificationExpiresAt: Date },
  ): Promise<Listing>;
  markDocumentsCleared(listingId: string, at: Date | null): Promise<Listing>;

  /* Claims */
  createClaim(data: {
    listingId: string;
    claimantPublisherId: string;
    evidenceNote?: string | null;
  }): Promise<ListingClaim>;
  findClaim(claimId: string): Promise<ListingClaim | null>;
  listClaims(status?: ListingClaimStatus, page?: PageQuery): Promise<Page<ListingClaim>>;
  decideClaim(
    claimId: string,
    data: { status: ListingClaimStatus; decisionNote?: string | null; decidedByUserId: string },
  ): Promise<ListingClaim>;
  /** Transfer an unclaimed listing to the winning claimant's new attempt. */
  assignListingOwner(listingId: string, publisherId: string, attemptId: string): Promise<Listing>;

  /* Compliance */
  openComplianceCase(data: {
    listingId: string;
    publisherId?: string | null;
    dueAt: Date;
  }): Promise<ComplianceCase>;
  findOpenCaseForListing(listingId: string): Promise<ComplianceCase | null>;
  findCase(caseId: string): Promise<ComplianceCase | null>;
  listCases(status?: ComplianceCaseStatus, page?: PageQuery): Promise<Page<ComplianceCase>>;
  addContactAttempt(data: {
    caseId: string;
    channel: ContactAttemptChannel;
    outcome: string;
    note?: string | null;
    attemptedByUserId?: string | null;
  }): Promise<unknown>;
  setCaseStatus(caseId: string, status: ComplianceCaseStatus): Promise<ComplianceCase>;
  /** Cases past dueAt that are still open — suspension falls due on these. */
  casesPastDue(now: Date, limit?: number): Promise<ComplianceCase[]>;

  /* Earnings holds — obligation only, no money moves. See the module README. */
  openHold(data: { listingId: string; publisherId: string; convertsAt: Date }): Promise<unknown>;
  releaseHolds(listingId: string): Promise<number>;

  /* Batch forms for the enforcement sweep. One round trip each. */
  listingIdsWithOpenCase(listingIds: string[]): Promise<string[]>;
  openHolds(rows: { listingId: string; publisherId: string; convertsAt: Date }[]): Promise<number>;
  openComplianceCases(
    rows: { listingId: string; publisherId: string | null; dueAt: Date }[],
  ): Promise<number>;
  suspendForCases(rows: { id: string; listingId: string }[]): Promise<number>;
}
