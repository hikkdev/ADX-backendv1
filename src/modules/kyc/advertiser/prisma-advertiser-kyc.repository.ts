import { Prisma, prisma } from '../../../shared/database';
import type { Advertiser, AdvertiserKyc, KycStatus } from '../../../shared/database';
import { KYC_QUEUE_STATES, deriveKycState, kycPartyStateWhere, kycQueueBaseWhere, type KycQueueState } from '../../../shared/kyc-state';
import type {
  AdvertiserDigioFields,
  AdvertiserKycKey,
  AdvertiserKycQueueRow,
  AdvertiserKycSort,
  AdvertiserDigioUpdate,
  AdvertiserKycFilter,
  AdvertiserKycRepository,
  AdvertiserPartySlice,
  KycRecordStamp,
  KycRequestStamp,
  ReviewStamp,
} from './advertiser-kyc.repository';
import type { AdvertiserKycColumns, NewAdvertiserKycColumns } from './advertiser-kyc.schema';

/* ── N3-B: the key ───────────────────────────────────────────────────────── */

/** The unique the key addresses: the row itself (a legacy row adopting its profile key), else the profile, else the user. */
function uniqueOf(key: AdvertiserKycKey): Prisma.AdvertiserKycWhereUniqueInput {
  if (key.id) return { id: key.id };
  if (key.advertiserProfileId) return { advertiserProfileId: key.advertiserProfileId };
  if (key.advertiserId) return { advertiserId: key.advertiserId };
  throw new Error('An advertiser KYC record needs a profile id or a user id');
}

/** What a created row carries of the key — both ids, either may be null. */
const keyColumns = (key: AdvertiserKycKey) => ({ advertiserProfileId: key.advertiserProfileId, advertiserId: key.advertiserId });

/** What an update writes of the key — a legacy row addressed by its id adopts the profile key it lacked; nothing is nulled. */
const adoptKey = (key: AdvertiserKycKey) => ({
  ...(key.advertiserProfileId ? { advertiserProfileId: key.advertiserProfileId } : {}),
  ...(key.advertiserId ? { advertiserId: key.advertiserId } : {}),
});

/* ── N3-B: the queue is every Advertiser ─────────────────────────────────── */

/** N3-B: the party's search box — name, company, display id, email or mobile contains. */
function searchWhere(q: string | undefined): Prisma.AdvertiserWhereInput {
  const term = q?.trim();
  if (!term) return {};
  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { companyName: { contains: term, mode: 'insensitive' } },
      { displayId: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
      { mobile: { contains: term } },
    ],
  };
}

/** The state the filter asks for: `state`, else the `status` alias, else `requested=true`. */
function stateOf(filter: AdvertiserKycFilter): KycQueueState | undefined {
  return filter.state ?? filter.status ?? (filter.requested === true ? 'REQUESTED' : undefined);
}

/**
 * The queue filter as a where over the Advertiser table: every party not yet
 * verified plus every party with a record, narrowed by state, assignment,
 * escalation, one advertiser (by profile id or user id) and the search box.
 */
function partyWhere(filter: AdvertiserKycFilter): Prisma.AdvertiserWhereInput {
  const parts: Prisma.AdvertiserWhereInput[] = [kycQueueBaseWhere(true)];
  const state = stateOf(filter);
  if (state) parts.push(kycPartyStateWhere(state, true));
  if (filter.requested === false && !state) parts.push({ NOT: kycPartyStateWhere('REQUESTED', true) });
  // Lot D (Q119): assignment is a record's column — a party with no record is assigned to nobody and matches neither facet.
  if (filter.assignedToId !== undefined) parts.push({ kyc: { is: { assignedToId: filter.assignedToId } } });
  // Lot G: escalated is `escalatedAt` set; a decision clears it.
  if (filter.escalated === true) parts.push({ kyc: { is: { escalatedAt: { not: null } } } });
  if (filter.escalated === false) parts.push({ OR: [{ kyc: null }, { kyc: { is: { escalatedAt: null } } }] });
  // N2-B / N3-B: one advertiser — the profile id or the user id.
  if (filter.advertiserId) parts.push({ OR: [{ id: filter.advertiserId }, { userId: filter.advertiserId }] });
  if (filter.q) parts.push(searchWhere(filter.q));
  return { AND: parts };
}

/** A row with no record spreads every record column as null. */
const EMPTY_RECORD = Object.fromEntries(Object.values(Prisma.AdvertiserKycScalarFieldEnum).map((column) => [column, null])) as {
  [K in keyof AdvertiserKyc]: null;
};

function partySlice(advertiser: Advertiser): AdvertiserPartySlice {
  return {
    id: advertiser.id,
    displayId: advertiser.displayId,
    name: advertiser.name,
    companyName: advertiser.companyName,
    email: advertiser.email,
    mobile: advertiser.mobile,
    city: advertiser.city,
    userId: advertiser.userId,
    kycStatus: advertiser.kycStatus,
    type: advertiser.type,
    createdAt: advertiser.createdAt,
  };
}

function toQueueRow(advertiser: Advertiser & { kyc: AdvertiserKyc | null }): AdvertiserKycQueueRow {
  const party = partySlice(advertiser);
  const record = advertiser.kyc;
  return {
    ...(record ?? EMPTY_RECORD),
    id: record?.id ?? advertiser.id,
    kycId: record?.id ?? null,
    state: deriveKycState(record, advertiser.kycStatus),
    party,
    advertiser: party,
  };
}

/** Lot G (Q127/142): a decision clears the escalation — the case is answered, whoever it was handed to. */
const CLEAR_ESCALATION = { escalatedAt: null, escalationSource: null, escalationReason: null, escalatedToUserId: null, escalatedById: null } as const;

export const prismaAdvertiserKycRepository: AdvertiserKycRepository = {
  async findPage(where: AdvertiserKycFilter, page: number, pageSize: number, sort?: AdvertiserKycSort) {
    // Ordering is what makes "breaches first" work across pages: a breach is
    // simply an old pending submission, so oldest-first — the default — puts
    // every late row on the first page. N3-B: parties with nothing submitted
    // (awaiting documents, requested) follow, by when the party arrived.
    // `newest` is the arrival order — the party's, now that the queue lists
    // parties — kept for a reviewer who wants what just came in.
    const orderBy: Prisma.AdvertiserOrderByWithRelationInput[] =
      sort === 'newest'
        ? [{ createdAt: 'desc' }]
        : [{ kyc: { submittedAt: { sort: 'asc', nulls: 'last' } } }, { createdAt: 'asc' }];
    const [rows, total] = await Promise.all([
      prisma.advertiser.findMany({
        where: partyWhere(where),
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy,
        include: { kyc: true },
      }),
      prisma.advertiser.count({ where: partyWhere(where) }),
    ]);
    return { items: rows.map(toQueueRow), total };
  },

  countBreached(where: AdvertiserKycFilter, cutoff: Date) {
    // Submitted rows only: a party with nothing in has no clock running.
    return prisma.advertiser.count({
      where: { AND: [partyWhere(where), { kyc: { is: { status: 'PENDING', submittedAt: { not: null, lt: cutoff } } } }] },
    });
  },

  async countByState(where: AdvertiserKycFilter) {
    const base: AdvertiserKycFilter = { ...where, state: undefined, status: undefined, requested: undefined };
    const entries = await Promise.all(
      KYC_QUEUE_STATES.map(async (state) => [state, await prisma.advertiser.count({ where: partyWhere({ ...base, state }) })] as const),
    );
    return Object.fromEntries(entries) as Record<KycQueueState, number>;
  },

  countEscalated(where: AdvertiserKycFilter) {
    return prisma.advertiser.count({
      where: { AND: [partyWhere({ ...where, escalated: undefined }), { kyc: { is: { escalatedAt: { not: null } } } }] },
    });
  },

  countRequested(where: AdvertiserKycFilter) {
    return prisma.advertiser.count({ where: partyWhere({ ...where, requested: undefined, status: undefined, state: 'REQUESTED' }) });
  },

  requestKyc(key: AdvertiserKycKey, stamp: KycRequestStamp) {
    const data = { requestedAt: stamp.at, requestedById: stamp.requestedById, requestedChannel: stamp.requestedChannel };
    return prisma.advertiserKyc.upsert({
      where: uniqueOf(key),
      update: { ...data, ...adoptKey(key) },
      create: { ...keyColumns(key), ...data },
    });
  },

  findByAdvertiserId(advertiserId: string) {
    return prisma.advertiserKyc.findUnique({ where: { advertiserId } });
  },

  findByProfileId(advertiserProfileId: string) {
    return prisma.advertiserKyc.findUnique({ where: { advertiserProfileId } });
  },

  findByKey(key: AdvertiserKycKey) {
    return prisma.advertiserKyc.findUnique({ where: uniqueOf(key) });
  },

  findById(id: string) {
    // Deliberately no advertiser join: the by-id response has never included it.
    return prisma.advertiserKyc.findUnique({ where: { id } });
  },

  create(key: AdvertiserKycKey, data: NewAdvertiserKycColumns) {
    // Lot N: the party's own hand — `recordedVia` SELF, the recorder themselves.
    return prisma.advertiserKyc.create({ data: { ...keyColumns(key), ...data, submittedAt: new Date(), ...SELF_STAMP(key.advertiserId) } });
  },

  resubmit(key: AdvertiserKycKey, data: AdvertiserKycColumns) {
    const now = new Date();
    return prisma.advertiserKyc.upsert({
      where: uniqueOf(key),
      update: { ...data, status: 'PENDING', rejectionReason: null, submittedAt: now, ...SELF_STAMP(key.advertiserId), ...adoptKey(key) },
      create: { ...keyColumns(key), ...data, status: 'PENDING', submittedAt: now, ...SELF_STAMP(key.advertiserId) },
    });
  },

  pinManifestVersion(key: AdvertiserKycKey, version: number) {
    return prisma.advertiserKyc.updateMany({ where: { ...uniqueOf(key), manifestVersion: null }, data: { manifestVersion: version } });
  },

  async updateById(id: string, data: AdvertiserKycColumns, stamp?: KycRecordStamp) {
    if (!stamp) return prisma.advertiserKyc.update({ where: { id }, data });
    // Lot N: recorded at the desk — who, how, the method; a first recording
    // gets its `submittedAt` so the queue can age it. The status is not
    // touched: that is what review is for.
    const current = await prisma.advertiserKyc.findUnique({ where: { id }, select: { submittedAt: true } });
    return prisma.advertiserKyc.update({
      where: { id },
      data: {
        ...data,
        recordedById: stamp.recordedById,
        recordedVia: stamp.recordedVia,
        method: stamp.method,
        ...(current?.submittedAt ? {} : { submittedAt: stamp.at }),
      },
    });
  },

  createAtDesk(key: AdvertiserKycKey, data: NewAdvertiserKycColumns, stamp: KycRecordStamp) {
    // N2-B: the desk's first recording — there was no row to update.
    return prisma.advertiserKyc.create({
      data: { ...keyColumns(key), ...data, status: 'PENDING', submittedAt: stamp.at, recordedById: stamp.recordedById, recordedVia: stamp.recordedVia, method: stamp.method },
    });
  },

  review(id: string, status: KycStatus, rejectionReason: string | null, stamp?: ReviewStamp) {
    return prisma.advertiserKyc.update({
      where: { id },
      data: {
        status,
        rejectionReason,
        reviewedAt: new Date(),
        ...(stamp ? { reviewedById: stamp.reviewedById, reviewNote: stamp.reviewNote ?? null } : {}),
        ...CLEAR_ESCALATION,
      },
    });
  },

  requestReupload(id: string, stamp: ReviewStamp) {
    return prisma.advertiserKyc.update({
      where: { id },
      data: { status: 'NEEDS_INFO', reviewedAt: new Date(), reviewedById: stamp.reviewedById, reviewNote: stamp.reviewNote ?? null },
    });
  },

  async assign(ids: string[], adminUserId: string | null, at: Date) {
    const { count } = await prisma.advertiserKyc.updateMany({
      where: { id: { in: ids } },
      data: { assignedToId: adminUserId, assignedAt: adminUserId ? at : null },
    });
    return count;
  },

  findPurgeable(cutoff: Date, limit: number) {
    return prisma.advertiserKyc.findMany({
      where: { method: 'DIGIO', status: 'VERIFIED', imagesPurgedAt: null, digioVerifiedAt: { not: null, lt: cutoff } },
      orderBy: { digioVerifiedAt: 'asc' },
      take: limit,
    });
  },

  purgeImages(id: string, data: { panNumber: string | null; digioPayload: unknown }) {
    return prisma.advertiserKyc.update({
      where: { id },
      data: {
        nationalIdUrl: null,
        panCardUrl: null,
        utilityBillUrl: null,
        drivingLicenseUrl: null,
        commercialIncCertUrl: null,
        commercialAssociationArticleUrl: null,
        commercialPanIdUrl: null,
        commercialGstCertUrl: null,
        ngoRegCertUrl: null,
        ngo80gCertUrl: null,
        ngoFcraRegUrl: null,
        agencyAuthLetterUrl: null,
        agencyGovtIdUrl: null,
        govIdFrontUrl: null,
        govIdBackUrl: null,
        panSignatureUrl: null,
        addressProofUrl: null,
        selfieUrl: null,
        panNumber: data.panNumber,
        digioPayload: data.digioPayload === null ? Prisma.DbNull : (data.digioPayload as Prisma.InputJsonValue),
        imagesPurgedAt: new Date(),
      },
    });
  },

  remove(id: string) {
    return prisma.advertiserKyc.delete({ where: { id } });
  },
  // ── U7, demand side: Digio on the advertiser's own row ───────────────

  upsertDigio(key: AdvertiserKycKey, fields: AdvertiserDigioFields) {
    return prisma.advertiserKyc.upsert({
      where: uniqueOf(key),
      update: { ...fields, ...adoptKey(key) },
      create: { ...keyColumns(key), ...fields },
    });
  },

  findByDigioRequestId(kycId: string) {
    return prisma.advertiserKyc.findFirst({ where: { digioRequestId: kycId } });
  },

  applyDigioWebhook(id: string, update: AdvertiserDigioUpdate) {
    // Lot N: Digio's completion is the recording — nobody at ADX held the
    // documents. N2-B: an approval puts the row on the Digio path whatever
    // was sent by hand while the session was open.
    return prisma.advertiserKyc.update({
      where: { id },
      data: {
        ...update,
        digioPayload: update.digioPayload as Prisma.InputJsonValue,
        recordedVia: 'DIGIO',
        recordedById: null,
        ...(update.status === 'VERIFIED' ? { method: 'DIGIO' } : {}),
      },
    });
  },
};

/** Lot N: the stamp the party's own submission carries — the recorder is the row's owner (their user, when they have one). */
const SELF_STAMP = (userId: string | null) => ({ recordedById: userId, recordedVia: 'SELF' as const, method: 'MANUAL' as const });
