import { Prisma, prisma } from '../../shared/database';
import type { KycStatus, OrderStatus, Gender } from '../../shared/database';
import { money } from '../../shared/money';
import { countsFrom, listArgs } from '../../shared/pagination';
import { kycPartyStateWhere, kycQueueBaseWhere, type KycQueueState } from '../../shared/kyc-state';
import { PUBLISHER_KYC_STATUSES, type MyListingsQuery, type PublisherRosterQuery } from './publishers.schema';
import {
  OCCUPYING_ORDER_STATUSES,
  type KycDocuments,
  type KycQueueFilter,
  type KycRecordStamp,
  type KycRequestStamp,
  type KycReviewStamp,
  type NewPublisher,
  type PublisherPatch,
  type PublishersRepository,
  toAgentLabel,
} from './publishers.repository';

/** N3-B: the queue's search box — name, display id, mobile, email or contact mobile contains. */
function kycQueueSearchWhere(q: string | undefined): Prisma.PublisherWhereInput {
  const term = q?.trim();
  if (!term) return {};
  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { displayId: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
      { mobile: { contains: term } },
      { contactMobile: { contains: term } },
    ],
  };
}

/** The state the filter asks for: `state`, else the `status` alias, else `requested=true`. */
const kycQueueStateOf = (filter: KycQueueFilter): KycQueueState | undefined => filter.state ?? filter.status ?? (filter.requested === true ? 'REQUESTED' : undefined);

/**
 * D7's queue listed submitted rows; Lot N added the desk's asks under
 * `requested=true`. N3-B (the owner, 14 Sep 2026): the queue lists PARTIES
 * — every publisher whose mirror is not VERIFIED plus every publisher with
 * a record — each in one of six states (`shared/kyc-state`), `state=` the
 * facet, `status=` its alias and `requested=true` the REQUESTED state; the
 * record-level facets (assignment, method, escalation, the Digio ones)
 * still narrow to rows that have a record.
 */
function kycQueueWhere(filter: KycQueueFilter): Prisma.PublisherWhereInput {
  // Lot D (Q129): a stuck Digio case was initiated before `stuckBefore` and
  // no webhook has landed — the payload column is what a webhook writes.
  const digio: Prisma.PublisherKycWhereInput =
    filter.digioStatus === 'stuck'
      ? { method: 'DIGIO', digioStatus: 'pending', digioPayload: { equals: Prisma.DbNull }, ...(filter.stuckBefore ? { submittedAt: { lt: filter.stuckBefore } } : {}) }
      : filter.digioStatus === 'pending'
        ? { method: 'DIGIO', digioStatus: 'pending' }
        : {};
  const record: Prisma.PublisherKycWhereInput = {
    ...(filter.assignedToId !== undefined ? { assignedToId: filter.assignedToId } : {}),
    ...(filter.method ? { method: filter.method } : {}),
    // Lot G: escalated is `escalatedAt` set; a decision clears it.
    ...(filter.escalated === true ? { escalatedAt: { not: null } } : filter.escalated === false ? { escalatedAt: null } : {}),
    ...digio,
  };
  const state = kycQueueStateOf(filter);
  const parts: Prisma.PublisherWhereInput[] = [kycQueueBaseWhere(true)];
  if (state) parts.push(kycPartyStateWhere(state, true));
  if (filter.requested === false && !state) parts.push({ NOT: kycPartyStateWhere('REQUESTED', true) });
  if (Object.keys(record).length) parts.push({ kyc: { is: record } });
  if (filter.unassigned) parts.push({ agentId: null });
  if (filter.q) parts.push(kycQueueSearchWhere(filter.q));
  return { AND: parts };
}

const detailInclude = {
  kyc: true,
  listings: {
    include: {
      photos: true,
      // E6: the non-terminal orders on each spot, so the detail read can say
      // what STOP_OPEN_WORK would cancel without a second call.
      _count: { select: { orders: { where: { status: { notIn: ['COMPLETED', 'CANCELLED'] as OrderStatus[] } } } } },
    },
  },
  // E6: whether the account behind the profile is closed (Lot A, Q21). QR-13:
  // and the person the desk may edit — the console's Edit details drawer prefills from these.
  user: { select: { closedAt: true, closeReason: true, displayId: true, firstName: true, lastName: true, dateOfBirth: true, gender: true, avatarUrl: true, consentAcceptedAt: true } },
  // P-B: who brought them in, joined the way the KYC queue joins it, so the
  // party page can print "Onboarded by" by name.
  agent: { select: { id: true, displayId: true, user: { select: { name: true } } } },
} satisfies Prisma.PublisherInclude;

/** P-B: the include's `agent { id, displayId, user { name } }` → `agent { id, displayId, name } | null` on every detail read. */
const withAgentLabel = <T extends { agent: { id: string; displayId: string | null; user: { name: string | null } | null } | null }>(row: T) => ({
  ...row,
  agent: toAgentLabel(row.agent),
});

/** E10-1: the roster's search box — name, display id, city or mobile contains. */
function rosterSearchWhere(q: string | undefined): Prisma.PublisherWhereInput {
  if (!q) return {};
  return {
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { displayId: { contains: q, mode: 'insensitive' } },
      { city: { contains: q, mode: 'insensitive' } },
      { mobile: { contains: q } },
    ],
  };
}

export const prismaPublishersRepository: PublishersRepository = {
  create(data: NewPublisher) {
    const { type, email, city, cityId, state, displayId, userId, address, latitude, longitude, gstin, contactName, contactMobile, contactEmail, onboardingStatus, activatedAt, onboardedVia, onboardedById, onboardedByRole, onboardedAt, ...required } = data;
    // Optional columns are omitted rather than set to undefined so Prisma
    // leaves schema defaults in place. The empty KYC row is created up front so
    // every publisher has one to submit into.
    return prisma.publisher.create({
      data: {
        ...required,
        ...(type !== undefined ? { type } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(city !== undefined ? { city } : {}),
        ...(cityId !== undefined ? { cityId } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(displayId !== undefined ? { displayId } : {}),
        // QR-13: the desk's onboarding — the account, the address and its pin, the business and contact facts.
        ...(userId !== undefined ? { userId } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(latitude !== undefined ? { latitude } : {}),
        ...(longitude !== undefined ? { longitude } : {}),
        ...(gstin !== undefined ? { gstin } : {}),
        ...(contactName !== undefined ? { contactName } : {}),
        ...(contactMobile !== undefined ? { contactMobile } : {}),
        ...(contactEmail !== undefined ? { contactEmail } : {}),
        ...(onboardingStatus !== undefined ? { onboardingStatus } : {}),
        ...(activatedAt !== undefined ? { activatedAt } : {}),
        // QR-14: the door this row came through.
        ...(onboardedVia !== undefined ? { onboardedVia } : {}),
        ...(onboardedById !== undefined ? { onboardedById } : {}),
        ...(onboardedByRole !== undefined ? { onboardedByRole } : {}),
        ...(onboardedAt !== undefined ? { onboardedAt } : {}),
        kyc: { create: {} },
      },
      include: { kyc: true, listings: true },
    }) as never;
  },

  // QR-14: the names behind the stamps.
  async userLabels(userIds) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  },

  // QR-13: the account behind a desk-opened publisher.
  async ensureAccount(input) {
    const { mobile, displayId, name, email, ...person } = input;
    const existing = await prisma.user.findUnique({ where: { mobile }, include: { roles: { select: { role: true } } } });
    if (existing) {
      // Fill only what is empty: a person who already is somebody keeps their own details.
      const fill: Record<string, unknown> = {};
      if (existing.firstName === null && person.firstName !== undefined) fill['firstName'] = person.firstName;
      if (existing.lastName === null && person.lastName !== undefined) fill['lastName'] = person.lastName;
      if (existing.dateOfBirth === null && person.dateOfBirth !== undefined) fill['dateOfBirth'] = person.dateOfBirth;
      if (existing.gender === null && person.gender !== undefined) fill['gender'] = person.gender;
      if (existing.name === null) fill['name'] = name;
      if (existing.email === null && email !== undefined) fill['email'] = email;
      if (!existing.roles.some((r) => r.role === 'PUBLISHER')) fill['roles'] = { create: { role: 'PUBLISHER' } };
      if (Object.keys(fill).length > 0) await prisma.user.update({ where: { id: existing.id }, data: fill });
      return { id: existing.id, created: false };
    }
    const created = await prisma.user.create({
      data: {
        mobile,
        displayId,
        name,
        ...(email !== undefined ? { email } : {}),
        ...(person.firstName !== undefined ? { firstName: person.firstName } : {}),
        ...(person.lastName !== undefined ? { lastName: person.lastName } : {}),
        ...(person.dateOfBirth !== undefined ? { dateOfBirth: person.dateOfBirth } : {}),
        ...(person.gender !== undefined ? { gender: person.gender } : {}),
        roles: { create: { role: 'PUBLISHER' } },
      },
      select: { id: true },
    });
    return { id: created.id, created: true };
  },

  async updateAccount(userId, patch) {
    await prisma.user.update({ where: { id: userId }, data: patch });
  },

  findByIdWithUser(publisherId) {
    return prisma.publisher.findUnique({ where: { id: publisherId }, include: { user: { select: { dateOfBirth: true } } } }) as never;
  },

  findKycQueue(filter) {
    return prisma.publisher.findMany({
      where: kycQueueWhere(filter),
      include: { kyc: true, agent: { select: { id: true, displayId: true, user: { select: { name: true } } } } },
      // The SLA ordering is applied in the service, over these rows: a breach
      // is submittedAt plus a number ops can change, which is not something
      // the database can order by without reading the settings row first.
      // Lot N: the requested facet has no submission to order by — the ask's moment orders it.
      // N3-B: parties with nothing submitted follow the submitted ones, by when the publisher arrived.
      orderBy:
        kycQueueStateOf(filter) === 'REQUESTED'
          ? [{ kyc: { requestedAt: { sort: filter.sort === 'newest' ? 'desc' : 'asc', nulls: 'last' } } }, { createdAt: filter.sort === 'newest' ? 'desc' : 'asc' }]
          : [{ kyc: { submittedAt: { sort: filter.sort === 'newest' ? 'desc' : 'asc', nulls: 'last' } } }, { createdAt: filter.sort === 'newest' ? 'desc' : 'asc' }],
    }) as never;
  },

  countKycQueue(filter) {
    return prisma.publisher.count({ where: kycQueueWhere(filter) });
  },

  requestKyc(publisherId: string, stamp: KycRequestStamp) {
    const data = { requestedAt: stamp.at, requestedById: stamp.requestedById, requestedChannel: stamp.requestedChannel };
    return prisma.publisherKyc.upsert({ where: { publisherId }, update: data, create: { publisherId, ...data } });
  },

  findKycDetail(publisherId: string) {
    return prisma.publisher.findUnique({
      where: { id: publisherId },
      include: { kyc: true, agent: { select: { id: true, displayId: true, user: { select: { name: true } } } } },
    }) as never;
  },

  async findForAgent(agentId: string, category?: string) {
    const rows = await prisma.publisher.findMany({
      where: {
        agentId,
        // 'KYC' is the UI's tab name, not a column — it filters to verified.
        ...(category === 'KYC' ? { kycStatus: 'VERIFIED' as const } : {}),
      },
      include: detailInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(withAgentLabel) as never;
  },

  /* The roster. Same shape as the agent's list, without the agent clause —
     ADX looks after all of them. Bounded, because it is a whole-table read. */
  async findAllForAdmin(category?: string, q?: string) {
    const rows = await prisma.publisher.findMany({
      where: { ...(category === 'KYC' ? { kycStatus: 'VERIFIED' as const } : {}), ...rosterSearchWhere(q) },
      include: detailInclude,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map(withAgentLabel) as never;
  },

  /* E10-1: the same roster on the list contract. The chips are the KYC
     statuses, counted over the search with the KYC tab removed so "KYC"
     never makes the other chips read zero. */
  async findRosterPage(query: PublisherRosterQuery) {
    const base: Prisma.PublisherWhereInput = {
      ...rosterSearchWhere(query.q),
      // QR-14: the door, and the person who opened it.
      ...(query.onboardedVia ? { onboardedVia: query.onboardedVia } : {}),
      ...(query.onboardedById ? { onboardedById: query.onboardedById } : {}),
    };
    const where: Prisma.PublisherWhereInput = { ...base, ...(query.category === 'KYC' ? { kycStatus: 'VERIFIED' as const } : {}) };
    const [items, total, groups] = await Promise.all([
      prisma.publisher.findMany({ where, include: detailInclude, orderBy: { createdAt: 'desc' }, ...listArgs(query) }),
      prisma.publisher.count({ where }),
      prisma.publisher.groupBy({ by: ['kycStatus'], where: base, _count: { _all: true } }),
    ]);
    return {
      items: items.map(withAgentLabel) as never,
      total,
      counts: countsFrom(
        groups.map((group) => ({ status: group.kycStatus, _count: group._count })),
        PUBLISHER_KYC_STATUSES,
      ),
    };
  },

  async findById(publisherId: string) {
    const row = await prisma.publisher.findUnique({
      where: { id: publisherId },
      include: detailInclude,
    });
    return (row ? withAgentLabel(row) : null) as never;
  },

  findSummaryById(publisherId: string) {
    return prisma.publisher.findUnique({ where: { id: publisherId } });
  },

  findByUserId(userId: string) {
    return prisma.publisher.findUnique({ where: { userId } });
  },

  async findLabelsByUserIds(userIds: string[]) {
    if (userIds.length === 0) return [];
    const rows = await prisma.publisher.findMany({
      where: { userId: { in: userIds } },
      select: { id: true, userId: true, displayId: true, name: true, kycStatus: true },
    });
    return rows.flatMap((row) => (row.userId ? [{ ...row, userId: row.userId }] : []));
  },

  async findPlatformAgreementAcceptedAt(publisherId: string) {
    const row = await prisma.agreementAcceptance.findFirst({
      where: { publisherId, templateKind: 'PLATFORM' },
      orderBy: { acceptedAt: 'desc' },
      select: { acceptedAt: true },
    });
    return row?.acceptedAt ?? null;
  },

  findByUserIdWithKyc(userId: string) {
    // QR-5: the person's date of birth and gender ride on the own read — the
    // readiness rule counts the first among the basics.
    return prisma.publisher.findUnique({
      where: { userId },
      include: { kyc: true, user: { select: { dateOfBirth: true, gender: true, avatarUrl: true } } },
    }) as never;
  },

  /**
   * The publisher's own listings, paged, with the three shelf counts.
   *
   * Occupancy is a live order on the spot — the same rule the dashboard gauge
   * uses, so the two can never disagree about whether a spot is busy. It is
   * expressed as a relation filter rather than computed after the fact,
   * because the chips have to filter and count on it in the database or the
   * page boundaries stop meaning anything.
   */
  async findMyListings(publisherId: string, query: MyListingsQuery) {
    const now = new Date();
    // Not `as const`: Prisma's where-inputs are mutable, and a readonly
    // literal here also collapses the include's row-type inference.
    const live: Prisma.OrderWhereInput = {
      status: { in: [...OCCUPYING_ORDER_STATUSES] },
      OR: [{ startDate: null }, { startDate: { lte: now } }],
      AND: [{ OR: [{ endDate: null }, { endDate: { gte: now } }] }],
    };

    const shelfWhere = (shelf: MyListingsQuery['shelf']): Prisma.ListingWhereInput =>
      shelf === 'AVAILABLE'
        ? { status: 'ACTIVE', orders: { none: live } }
        : shelf === 'OCCUPIED'
          ? { status: 'ACTIVE', orders: { some: live } }
          : shelf === 'INACTIVE'
            ? { NOT: { status: 'ACTIVE' } }
            : {};

    const base: Prisma.ListingWhereInput = {
      publisherId,
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { address: { contains: query.q, mode: 'insensitive' } },
              { city: { contains: query.q, mode: 'insensitive' } },
              { placement: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const where: Prisma.ListingWhereInput = { AND: [base, shelfWhere(query.shelf)] };

    const orderBy: Prisma.ListingOrderByWithRelationInput =
      query.sort === 'OLDEST'
        ? { createdAt: 'asc' }
        : query.sort === 'RATE_ASC'
          ? { ratePerDay: 'asc' }
          : query.sort === 'RATE_DESC'
            ? { ratePerDay: 'desc' }
            : query.sort === 'TITLE'
              ? { title: 'asc' }
              : { createdAt: 'desc' };

    // Each chip is counted over the search, never over the chip in force, so
    // the row of chips stays a way back out of whichever one is selected.
    const [rows, total, available, occupied, inactive] = await Promise.all([
      prisma.listing.findMany({
        where,
        orderBy,
        ...listArgs(query),
        include: { photos: true, orders: { where: live, select: { id: true }, take: 1 } },
      }),
      prisma.listing.count({ where }),
      prisma.listing.count({ where: { AND: [base, shelfWhere('AVAILABLE')] } }),
      prisma.listing.count({ where: { AND: [base, shelfWhere('OCCUPIED')] } }),
      prisma.listing.count({ where: { AND: [base, shelfWhere('INACTIVE')] } }),
    ]);

    return {
      items: rows.map(({ orders, ...listing }) => ({ ...listing, occupied: orders.length > 0 })),
      total,
      counts: { AVAILABLE: available, OCCUPIED: occupied, INACTIVE: inactive },
    };
  },

  async findDashboard(publisherId: string, now: Date) {
    const [rows, awaiting] = await Promise.all([
      prisma.listing.findMany({
        where: { publisherId },
        select: {
          id: true,
          title: true,
          status: true,
          latitude: true,
          longitude: true,
          orders: {
            where: {
              status: { in: [...OCCUPYING_ORDER_STATUSES] },
              OR: [{ startDate: null }, { startDate: { lte: now } }],
              AND: [{ OR: [{ endDate: null }, { endDate: { gte: now } }] }],
            },
            select: {
              id: true,
              campaignName: true,
              budget: true,
              startDate: true,
              endDate: true,
              status: true,
              advertiser: { select: { name: true } },
              agent: { select: { id: true, user: { select: { name: true, mobile: true } } } },
            },
            orderBy: { startDate: 'asc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.order.count({ where: { status: 'PENDING_PUBLISHER', listing: { publisherId } } }),
    ]);
    return {
      listings: rows.map((row) => {
        const order = row.orders[0] ?? null;
        return {
          id: row.id,
          title: row.title,
          status: row.status,
          latitude: row.latitude,
          longitude: row.longitude,
          occupied: order !== null,
          booking: order
            ? {
                orderId: order.id,
                advertiserName: order.advertiser.name,
                campaignName: order.campaignName,
                amount: order.budget === null ? null : money(order.budget),
                startDate: order.startDate,
                endDate: order.endDate,
                status: order.status,
                agent: order.agent ? { id: order.agent.id, name: order.agent.user.name, phone: order.agent.user.mobile } : null,
              }
            : null,
        };
      }),
      awaiting,
    };
  },

  update(publisherId: string, data: PublisherPatch) {
    return prisma.publisher.update({
      where: { id: publisherId },
      data,
      include: { kyc: true, listings: true },
    }) as never;
  },

  async submitKyc(publisherId: string, docs: KycDocuments, stamp?: KycRecordStamp) {
    // One transaction: the KYC row and the publisher's mirrored kycStatus must
    // never disagree. Lot N: who recorded it and how ride the same write.
    const recorded = stamp ? { recordedById: stamp.recordedById, recordedVia: stamp.recordedVia, ...(stamp.method ? { method: stamp.method } : {}) } : {};
    const [kyc] = await prisma.$transaction([
      prisma.publisherKyc.upsert({
        where: { publisherId },
        update: { ...docs, ...recorded, status: 'PENDING', submittedAt: new Date() },
        create: { publisherId, ...docs, ...recorded, status: 'PENDING', submittedAt: new Date() },
      }),
      prisma.publisher.update({ where: { id: publisherId }, data: { kycStatus: 'PENDING' } }),
    ]);
    return kyc;
  },

  pinKycManifestVersion(publisherId: string, version: number) {
    return prisma.publisherKyc.updateMany({ where: { publisherId, manifestVersion: null }, data: { manifestVersion: version } });
  },

  async reviewKyc(publisherId: string, status: KycStatus, rejectionReason?: string, stamp?: KycReviewStamp) {
    const [kyc] = await prisma.$transaction([
      prisma.publisherKyc.update({
        where: { publisherId },
        data: {
          status,
          rejectionReason,
          reviewedAt: new Date(),
          ...(stamp ? { reviewedById: stamp.reviewedById, reviewNote: stamp.reviewNote ?? null } : {}),
          // Lot G (Q127/142): a decision clears the escalation — the case is answered, whoever it was handed to.
          escalatedAt: null,
          escalationSource: null,
          escalationReason: null,
          escalatedToUserId: null,
          escalatedById: null,
        },
      }),
      prisma.publisher.update({ where: { id: publisherId }, data: { kycStatus: status } }),
    ]);
    return kyc;
  },

  async requestKycReupload(publisherId: string, stamp: KycReviewStamp) {
    // The same one-transaction rule as review: the row and the mirror never disagree.
    const [kyc] = await prisma.$transaction([
      prisma.publisherKyc.update({
        where: { publisherId },
        data: { status: 'NEEDS_INFO', reviewedAt: new Date(), reviewedById: stamp.reviewedById, reviewNote: stamp.reviewNote ?? null },
      }),
      prisma.publisher.update({ where: { id: publisherId }, data: { kycStatus: 'NEEDS_INFO' } }),
    ]);
    return kyc;
  },

  async assignKyc(publisherIds: string[], adminUserId: string | null, at: Date) {
    const { count } = await prisma.publisherKyc.updateMany({
      where: { publisherId: { in: publisherIds } },
      data: { assignedToId: adminUserId, assignedAt: adminUserId ? at : null },
    });
    return count;
  },

  findPurgeableKyc(cutoff: Date, limit: number) {
    return prisma.publisherKyc.findMany({
      where: { method: 'DIGIO', status: 'VERIFIED', imagesPurgedAt: null, digioVerifiedAt: { not: null, lt: cutoff } },
      orderBy: { digioVerifiedAt: 'asc' },
      take: limit,
    });
  },

  purgeKycImages(kycId: string, data: { panNumber: string | null; digioPayload: unknown }) {
    return prisma.publisherKyc.update({
      where: { id: kycId },
      data: {
        aadhaarFrontUrl: null,
        aadhaarBackUrl: null,
        panFrontUrl: null,
        panBackUrl: null,
        gstUrl: null,
        addressProofUrl: null,
        bankStatement: null,
        govIdFrontUrl: null,
        govIdBackUrl: null,
        panSignatureUrl: null,
        selfieUrl: null,
        businessRegCertUrl: null,
        directorIdUrl: null,
        businessAddressProofUrl: null,
        adAuthLetterUrl: null,
        ngoRegCertUrl: null,
        ngoAddressProofUrl: null,
        ngoTaxExemptionCertUrl: null,
        ngoOperationalOverviewUrl: null,
        panNumber: data.panNumber,
        digioPayload: data.digioPayload === null ? Prisma.DbNull : (data.digioPayload as Prisma.InputJsonValue),
        imagesPurgedAt: new Date(),
      },
    });
  },

  async findKycByUserId(userId: string) {
    const publisher = await prisma.publisher.findUnique({ where: { userId }, select: { kyc: true } });
    return publisher?.kyc ?? null;
  },

  findByMobile(mobile: string) {
    return prisma.publisher.findUnique({ where: { mobile } });
  },

  attachUser(publisherId: string, userId: string) {
    return prisma.publisher.update({ where: { id: publisherId }, data: { userId } });
  },

  createSelfRegistered({ userId, name, mobile, email, displayId, type }) {
    return prisma.publisher.create({
      data: {
        userId,
        name,
        mobile,
        email,
        onboardingStatus: 'PENDING_ONBOARDING',
        // QR-14: the app's own door.
        onboardedVia: 'SELF',
        onboardedAt: new Date(),
        ...(displayId !== undefined ? { displayId } : {}),
        ...(type !== undefined ? { type } : {}),
      },
    });
  },

  setUserProfile(userId: string, name: string, email?: string) {
    return prisma.user.update({ where: { id: userId }, data: { name, email } });
  },

  /** QR-5: the person's details the ladder collects beside the publisher's. */
  setUserDetails(userId: string, data: { dateOfBirth?: Date; gender?: Gender }) {
    return prisma.user.update({ where: { id: userId }, data });
  },

  findUserMobile(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { mobile: true, name: true, avatarUrl: true } });
  },

  async claim(publisherId: string, agentId: string) {
    const claimed = await prisma.publisher.update({
      where: { id: publisherId },
      data: { agentId, claimedAt: new Date(), onboardingStatus: 'IN_ONBOARDING' },
    });
    // QR-14: a scan is the door only for a row nobody has stamped yet — a
    // desk-opened publisher an agent then walks through keeps the desk's stamp.
    const agent = await prisma.agentProfile.findUnique({ where: { id: agentId }, select: { userId: true } });
    if (agent) {
      await prisma.publisher.updateMany({
        where: { id: publisherId, onboardedVia: null },
        data: { onboardedVia: 'QR', onboardedById: agent.userId, onboardedByRole: 'Agent', onboardedAt: new Date() },
      });
    }
    return claimed;
  },

  resetOnboardingState(publisherId: string) {
    return prisma.publisher.update({
      where: { id: publisherId },
      data: { onboardingStatus: 'PENDING_ONBOARDING', agentId: null, claimedAt: null },
    });
  },

  findLabelsByIds(ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.publisher
      .findMany({ where: { id: { in: ids } }, select: { id: true, name: true, displayId: true } })
      .then((rows) => rows.map((row) => ({ id: row.id, label: row.name, displayId: row.displayId })));
  },

  completeOnboarding(publisherId: string) {
    return prisma.publisher.update({
      where: { id: publisherId },
      data: { onboardingStatus: 'ONBOARDING_COMPLETE' },
    });
  },
};
