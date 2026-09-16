import { Prisma, prisma } from '../../shared/database';
import { MAX_PAGE_SIZE, pageArgs, toPage, type PageQuery } from '../../shared/pagination';
import type {
  AgreementAcceptance,
  AgreementKind,
  ComplianceCaseStatus,
  Listing,
  ListingAttemptOrigin,
  ListingAttemptStatus,
  ListingClaimStatus,
} from '../../shared/database';
import type {
  ResolvedAttemptListing,
  NewListingAttempt,
  NewVerification,
  SupplyRepository,
} from './supply.repository';

/** Lot D: the schema holds a list (one acceptance per template version per attempt); every reader wants the newest. */
function withAcceptance<T extends { acceptances: AgreementAcceptance[] }>(row: T): Omit<T, 'acceptances'> & { acceptance: AgreementAcceptance | null } {
  const { acceptances, ...rest } = row;
  return { ...rest, acceptance: acceptances[0] ?? null };
}

/** Upper bound on listings returned with an attempt. See `findAttempt`. */
const ATTEMPT_LISTING_CAP = 1000;

/** How many rows one enforcement pass will consider. */
const SWEEP_BATCH = 500;

/**
 * A verification always travels with its named shots, ordered as the agent was
 * walked through them. A reviewer looking at "decal from an angle" out of
 * sequence cannot tell whether the angle was the one asked for.
 */
const verificationInclude = { photos: { orderBy: { order: 'asc' } } } as const;

/** Listing statuses that mean "listed, but not yet earning". */
const IN_FLIGHT: Listing['status'][] = [
  'AWAITING_AGREEMENT',
  'AWAITING_DOCUMENTS',
  'PENDING_REVIEW',
  'AWAITING_SITE_VERIFICATION',
];

export const prismaSupplyRepository: SupplyRepository = {
  /* ---------------------------------------------------------------- */
  /* Funnel                                                            */
  /* ---------------------------------------------------------------- */

  async funnel() {
    const [
      accountsCreated,
      kycVerified,
      platformAgreementAccepted,
      withInventory,
      listingAgreementAccepted,
      listingsLive,
      awaitingAgreement,
      awaitingDocuments,
      pendingDocumentReview,
      awaitingSiteVerification,
    ] = await Promise.all([
      prisma.publisher.count(),
      prisma.publisher.count({ where: { kycStatus: 'VERIFIED' } }),
      prisma.agreementAcceptance.count({ where: { templateKind: 'PLATFORM' } }),
      prisma.publisher.count({ where: { listings: { some: {} } } }),
      prisma.agreementAcceptance.count({ where: { templateKind: 'LISTING' } }),
      prisma.listing.count({ where: { status: 'ACTIVE' } }),
      prisma.listing.count({ where: { status: 'AWAITING_AGREEMENT' } }),
      prisma.listing.count({ where: { status: 'AWAITING_DOCUMENTS' } }),
      prisma.listing.count({ where: { status: 'PENDING_REVIEW' } }),
      prisma.listing.count({ where: { status: 'AWAITING_SITE_VERIFICATION' } }),
    ]);

    return {
      accountsCreated,
      kycVerified,
      platformAgreementAccepted,
      withInventory,
      listingAgreementAccepted,
      listingsLive,
      stuckOnPublisher: { awaitingAgreement, awaitingDocuments },
      stuckOnAdx: { pendingDocumentReview, awaitingSiteVerification },
    };
  },

  async publisherFunnelRows(limit: number, offset: number) {
    const rows = await prisma.publisher.findMany({
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        city: true,
        isPartnerPublisher: true,
        kycStatus: true,
        activatedAt: true,
        createdAt: true,
        agreementAcceptances: {
          where: { templateKind: 'PLATFORM' },
          select: { acceptedAt: true },
          take: 1,
        },
        // Counted in the database, not fetched and counted here. A partner
        // publisher holds hundreds of spots, so selecting the rows to call
        // .length on them pulled thousands of records per page to produce two
        // numbers.
        _count: { select: { listings: true } },
      },
    });

    // The live count needs a filtered relation, which `_count` cannot express
    // in the same query, so it is one grouped count for the whole page rather
    // than one query per row.
    const liveCounts = await prisma.listing.groupBy({
      by: ['publisherId'],
      where: { status: 'ACTIVE', publisherId: { in: rows.map((row) => row.id) } },
      _count: { _all: true },
    });
    const liveByPublisher = new Map(
      liveCounts.map((entry) => [entry.publisherId, entry._count._all]),
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      city: row.city,
      isPartnerPublisher: row.isPartnerPublisher,
      kycStatus: row.kycStatus,
      platformAgreementAcceptedAt: row.agreementAcceptances[0]?.acceptedAt ?? null,
      activatedAt: row.activatedAt,
      listingCount: row._count.listings,
      liveListingCount: liveByPublisher.get(row.id) ?? 0,
      createdAt: row.createdAt,
    }));
  },

  /* ---------------------------------------------------------------- */
  /* Agreement templates                                               */
  /* ---------------------------------------------------------------- */

  activeTemplate(kind: AgreementKind) {
    return prisma.agreementTemplate.findFirst({
      where: { kind, isActive: true },
      orderBy: { version: 'desc' },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Acceptances                                                       */
  /* ---------------------------------------------------------------- */

  findAcceptance(publisherId: string, templateId: string) {
    // Lot D: the platform-scope acceptance — the one with no transaction anchor.
    return prisma.agreementAcceptance.findFirst({
      where: { publisherId, templateId, attemptId: null, campaignId: null, packageSaleId: null, orderId: null },
    });
  },

  findPlatformAcceptance(publisherId: string) {
    // Lot D (Q55): the highest version clicked — the re-acceptance gate reads it.
    return prisma.agreementAcceptance.findFirst({
      where: { publisherId, templateKind: 'PLATFORM' },
      orderBy: [{ templateVersion: 'desc' }, { acceptedAt: 'desc' }],
    });
  },

  createAcceptance(data) {
    return prisma.agreementAcceptance.create({ data });
  },

  async markPublisherActivated(publisherId: string) {
    await prisma.publisher.update({
      where: { id: publisherId },
      data: { activatedAt: new Date() },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Attempts                                                          */
  /* ---------------------------------------------------------------- */

  createAttempt(data: NewListingAttempt) {
    return prisma.listingAttempt.create({ data });
  },

  async findAttempt(attemptId: string) {
    const row = await prisma.listingAttempt.findUnique({
      where: { id: attemptId },
      include: {
        // Bounded, but generously: the listing agreement has to enumerate every
        // spot in the batch, so a caller that renders it must compare
        // `listings.length` against `_count.listings` and refuse to proceed on
        // a truncated set rather than sign a partial document.
        listings: { orderBy: { createdAt: 'asc' }, take: ATTEMPT_LISTING_CAP },
        // Lot D: the newest acceptance stands in for the one-to-one the schema had.
        acceptances: { orderBy: { acceptedAt: 'desc' }, take: 1 },
        _count: { select: { listings: true } },
      },
    });
    return row ? withAcceptance(row) : null;
  },

  async listAttempts(
    filter: {
      status?: ListingAttemptStatus;
      publisherId?: string;
      origin?: ListingAttemptOrigin;
    },
    page: PageQuery = {},
  ) {
    const rows = await prisma.listingAttempt.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.publisherId ? { publisherId: filter.publisherId } : {}),
        ...(filter.origin ? { origin: filter.origin } : {}),
      },
      // A bulk attempt holds hundreds of listings; the list view shows a
      // handful as a preview and the detail view pages through the rest.
      include: {
        listings: { orderBy: { createdAt: 'asc' }, take: 5 },
        // Lot D: the newest acceptance stands in for the one-to-one the schema had.
        acceptances: { orderBy: { acceptedAt: 'desc' }, take: 1 },
        _count: { select: { listings: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(page),
    });
    return toPage(rows.map(withAcceptance), page);
  },

  setAttemptStatus(attemptId: string, status: ListingAttemptStatus) {
    return prisma.listingAttempt.update({ where: { id: attemptId }, data: { status } });
  },

  async addListingsToAttempt(attemptId: string, rows: ResolvedAttemptListing[]) {
    const attempt = await prisma.listingAttempt.findUnique({
      where: { id: attemptId },
      select: { publisherId: true, origin: true },
    });
    if (!attempt) return 0;

    // A scraped batch has no owner yet, so its listings start UNCLAIMED. Every
    // other origin is owned from the start and waits on the agreement.
    const status: Listing['status'] = attempt.origin === 'SCRAPE' ? 'UNCLAIMED' : 'AWAITING_AGREEMENT';

    const now = new Date();
    const created = await prisma.listing.createMany({
      data: rows.map(({ ratePerDay, monthlyPrice, ...row }) => {
        const rate = new Prisma.Decimal(ratePerDay);
        return {
          ...row,
          publisherId: attempt.publisherId,
          attemptId,
          status,
          ratePerDay: rate,
          // Derived only when the caller did not send one, so a spreadsheet of
          // monthly prices reads back as the numbers it contained. 30, not the
          // real month length, so a rate does not wobble with the calendar.
          monthlyPrice: monthlyPrice ?? rate.times(30).toNumber(),
          ratePerDaySetAt: now,
        };
      }),
    });
    return created.count;
  },

  async attemptProgress(attemptId: string) {
    // Counted in the database. Fetching every listing in a two-hundred-spot
    // batch to call .length on it is the same mistake as the funnel had.
    const [listingCount, documentsCleared, documentsRejected, awaitingSiteVerification, live] =
      await Promise.all([
        prisma.listing.count({ where: { attemptId } }),
        prisma.listing.count({ where: { attemptId, documentsClearedAt: { not: null } } }),
        prisma.listingDocument.count({
          where: { listing: { attemptId }, status: 'REJECTED' },
        }),
        prisma.listing.count({ where: { attemptId, status: 'AWAITING_SITE_VERIFICATION' } }),
        prisma.listing.count({ where: { attemptId, status: 'ACTIVE' } }),
      ]);

    return {
      attemptId,
      listingCount,
      documentsCleared,
      documentsRejected,
      awaitingSiteVerification,
      live,
    };
  },

  async advanceAttemptListings(attemptId: string) {
    const result = await prisma.listing.updateMany({
      where: { attemptId, status: 'AWAITING_AGREEMENT' },
      data: { status: 'AWAITING_DOCUMENTS' },
    });
    return result.count;
  },

  /* ---------------------------------------------------------------- */
  /* Documents                                                         */
  /* ---------------------------------------------------------------- */

  addDocument(data) {
    return prisma.listingDocument.create({ data });
  },

  findDocument(documentId: string) {
    return prisma.listingDocument.findUnique({ where: { id: documentId } });
  },

  reviewDocument(documentId, data) {
    return prisma.listingDocument.update({
      where: { id: documentId },
      data: {
        status: data.status,
        rejectionReason: data.rejectionReason ?? null,
        reviewedByUserId: data.reviewedByUserId,
        reviewedAt: new Date(),
      },
    });
  },

  listDocuments(listingId: string) {
    return prisma.listingDocument.findMany({
      where: { listingId },
      orderBy: { submittedAt: 'desc' },
      take: MAX_PAGE_SIZE,
    });
  },

  async documentsCleared(listingId: string) {
    const [total, verified] = await Promise.all([
      prisma.listingDocument.count({ where: { listingId } }),
      prisma.listingDocument.count({ where: { listingId, status: 'VERIFIED' } }),
    ]);
    return total > 0 && total === verified;
  },

  /* ---------------------------------------------------------------- */
  /* Verification                                                      */
  /* ---------------------------------------------------------------- */

  createVerification(data: NewVerification) {
    // The named shots are written in the same statement as their parent: a
    // verification that exists with none of its photos is a review request a
    // reviewer cannot act on.
    const { photos, ...verification } = data;
    return prisma.listingVerification.create({
      data: { ...verification, photos: { create: photos } },
      include: verificationInclude,
    });
  },

  findVerification(verificationId: string) {
    return prisma.listingVerification.findUnique({ where: { id: verificationId } });
  },

  reviewVerification(verificationId, data) {
    return prisma.listingVerification.update({
      where: { id: verificationId },
      data: {
        status: data.status,
        rejectionReason: data.rejectionReason ?? null,
        reviewedByUserId: data.reviewedByUserId,
        reviewedAt: new Date(),
      },
    });
  },

  listVerifications(listingId: string) {
    return prisma.listingVerification.findMany({
      where: { listingId },
      include: verificationInclude,
      orderBy: { createdAt: 'desc' },
      take: MAX_PAGE_SIZE,
    });
  },

  async verificationsDue(before: Date, limit = SWEEP_BATCH) {
    const rows = await prisma.listing.findMany({
      where: {
        verificationExpiresAt: { not: null, lte: before },
        status: { in: ['ACTIVE', 'SUSPENDED'] },
      },
      orderBy: { verificationExpiresAt: 'asc' },
      take: limit,
      select: {
        id: true,
        title: true,
        publisherId: true,
        removability: true,
        verifiedAt: true,
        verificationExpiresAt: true,
        status: true,
        publisher: { select: { name: true } },
      },
    });

    return rows.map((row) => ({
      listingId: row.id,
      title: row.title,
      publisherId: row.publisherId,
      publisherName: row.publisher?.name ?? null,
      removability: row.removability,
      verifiedAt: row.verifiedAt,
      verificationExpiresAt: row.verificationExpiresAt,
      status: row.status,
    }));
  },

  /* ---------------------------------------------------------------- */
  /* Listings                                                          */
  /* ---------------------------------------------------------------- */

  findListing(listingId: string) {
    return prisma.listing.findUnique({ where: { id: listingId } });
  },

  setListingStatus(listingId: string, status: Listing['status']) {
    return prisma.listing.update({
      where: { id: listingId },
      data: {
        status,
        ...(status === 'SUSPENDED' ? { suspendedAt: new Date() } : {}),
        ...(status === 'ACTIVE' ? { suspendedAt: null, publishedAt: new Date() } : {}),
      },
    });
  },

  markListingVerified(listingId, data) {
    return prisma.listing.update({ where: { id: listingId }, data });
  },

  markDocumentsCleared(listingId: string, at: Date | null) {
    return prisma.listing.update({
      where: { id: listingId },
      data: { documentsClearedAt: at },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Claims                                                            */
  /* ---------------------------------------------------------------- */

  createClaim(data) {
    return prisma.listingClaim.create({ data });
  },

  findClaim(claimId: string) {
    return prisma.listingClaim.findUnique({ where: { id: claimId } });
  },

  async listClaims(status?: ListingClaimStatus, page: PageQuery = {}) {
    const rows = await prisma.listingClaim.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'asc' },
      ...pageArgs(page),
    });
    return toPage(rows, page);
  },

  decideClaim(claimId, data) {
    return prisma.listingClaim.update({
      where: { id: claimId },
      data: {
        status: data.status,
        decisionNote: data.decisionNote ?? null,
        decidedByUserId: data.decidedByUserId,
        decidedAt: new Date(),
      },
    });
  },

  assignListingOwner(listingId: string, publisherId: string, attemptId: string) {
    return prisma.listing.update({
      where: { id: listingId },
      data: { publisherId, attemptId, status: 'AWAITING_AGREEMENT' },
    });
  },

  /* ---------------------------------------------------------------- */
  /* Compliance                                                        */
  /* ---------------------------------------------------------------- */

  openComplianceCase(data) {
    return prisma.complianceCase.create({
      data: { ...data, reason: 'VERIFICATION_LAPSED' },
    });
  },

  findOpenCaseForListing(listingId: string) {
    return prisma.complianceCase.findFirst({
      where: { listingId, status: { in: ['OPEN', 'CONTACTED', 'ESCALATED'] } },
      orderBy: { openedAt: 'desc' },
    });
  },

  findCase(caseId: string) {
    return prisma.complianceCase.findUnique({ where: { id: caseId } });
  },

  async listCases(status?: ComplianceCaseStatus, page: PageQuery = {}) {
    const rows = await prisma.complianceCase.findMany({
      where: status ? { status } : {},
      orderBy: { dueAt: 'asc' },
      ...pageArgs(page),
    });
    return toPage(rows, page);
  },

  addContactAttempt(data) {
    return prisma.complianceContactAttempt.create({ data });
  },

  setCaseStatus(caseId: string, status: ComplianceCaseStatus) {
    return prisma.complianceCase.update({
      where: { id: caseId },
      data: { status, ...(status === 'RESOLVED' ? { resolvedAt: new Date() } : {}) },
    });
  },

  casesPastDue(now: Date, limit = SWEEP_BATCH) {
    return prisma.complianceCase.findMany({
      where: { status: { in: ['OPEN', 'CONTACTED'] }, dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: limit,
    });
  },

  /* ---------------------------------------------------------------- */
  /* Earnings holds                                                    */
  /* ---------------------------------------------------------------- */

  openHold(data) {
    return prisma.earningsHold.create({ data });
  },

  /* Batch forms used by the enforcement sweep — one round trip each, rather
     than one per lapsed listing. */

  async listingIdsWithOpenCase(listingIds: string[]) {
    if (listingIds.length === 0) return [];
    const rows = await prisma.complianceCase.findMany({
      where: {
        listingId: { in: listingIds },
        status: { in: ['OPEN', 'CONTACTED', 'ESCALATED'] },
      },
      select: { listingId: true },
      distinct: ['listingId'],
    });
    return rows.map((row) => row.listingId);
  },

  async openHolds(rows) {
    const result = await prisma.earningsHold.createMany({ data: rows });
    return result.count;
  },

  async openComplianceCases(rows) {
    const result = await prisma.complianceCase.createMany({
      data: rows.map((row) => ({ ...row, reason: 'VERIFICATION_LAPSED' as const })),
    });
    return result.count;
  },

  /**
   * Suspension and escalation together. Wrapped in a transaction so a partial
   * failure cannot leave a listing suspended with its case still counting down,
   * which the next sweep would then suspend again.
   */
  async suspendForCases(rows) {
    if (rows.length === 0) return 0;
    const [listings] = await prisma.$transaction([
      prisma.listing.updateMany({
        where: { id: { in: rows.map((row) => row.listingId) } },
        data: { status: 'SUSPENDED', suspendedAt: new Date() },
      }),
      prisma.complianceCase.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { status: 'ESCALATED' },
      }),
    ]);
    return listings.count;
  },

  async releaseHolds(listingId: string) {
    const result = await prisma.earningsHold.updateMany({
      where: { listingId, status: 'HELD' },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    return result.count;
  },
};

export { IN_FLIGHT };
