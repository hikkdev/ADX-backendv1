import { Prisma, prisma } from '../../../shared/database';
import type { KycStatus, PrintPartner, PrintPartnerKyc } from '../../../shared/database';
import { KYC_QUEUE_STATES, deriveKycState, kycPartyStateWhere, kycQueueBaseWhere, type KycQueueState } from '../../../shared/kyc-state';
import type {
  DigioFields,
  DigioWebhookUpdate,
  PartnerSlice,
  PrintPartnerKycFilter,
  PrintPartnerKycQueueRow,
  PrintPartnerKycRepository,
  PrintPartnerKycSort,
  RequestStamp,
} from './print-partner-kyc.repository';

const partnerSelect = { id: true, displayId: true, name: true, mobile: true, email: true, userId: true, city: true, isActive: true, kycStatus: true, createdAt: true } as const;

const partnerInclude = { printPartner: { select: partnerSelect } } as const;

/* ── N3-B: the queue is every print partner ──────────────────────────────── */

/** The state the filter asks for: `state`, else the `status` alias, else `requested=true`. */
const stateOf = (filter: PrintPartnerKycFilter): KycQueueState | undefined => filter.state ?? filter.status ?? (filter.requested === true ? 'REQUESTED' : undefined);

/** The partner's search box — name, display id or mobile contains. */
function searchWhere(q: string | undefined): Prisma.PrintPartnerWhereInput {
  const term = q?.trim();
  if (!term) return {};
  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { displayId: { contains: term, mode: 'insensitive' } },
      { mobile: { contains: term } },
    ],
  };
}

/**
 * The queue filter as a where over the PrintPartner table: every partner
 * not yet verified plus every partner with a record, narrowed by state,
 * assignment, escalation and the search box. Assignment and escalation are
 * a record's columns — a partner with no record matches neither facet.
 */
function partyWhere(filter: PrintPartnerKycFilter): Prisma.PrintPartnerWhereInput {
  const parts: Prisma.PrintPartnerWhereInput[] = [kycQueueBaseWhere(true)];
  const state = stateOf(filter);
  if (state) parts.push(kycPartyStateWhere(state, true));
  if (filter.requested === false && !state) parts.push({ NOT: kycPartyStateWhere('REQUESTED', true) });
  if (filter.assignedToId !== undefined) parts.push({ kyc: { is: { assignedToId: filter.assignedToId } } });
  if (filter.escalated === true) parts.push({ kyc: { is: { escalatedAt: { not: null } } } });
  if (filter.escalated === false) parts.push({ OR: [{ kyc: null }, { kyc: { is: { escalatedAt: null } } }] });
  if (filter.q) parts.push(searchWhere(filter.q));
  return { AND: parts };
}

/** A row with no record spreads every record column as null. */
const EMPTY_RECORD = Object.fromEntries(Object.values(Prisma.PrintPartnerKycScalarFieldEnum).map((column) => [column, null])) as { [K in keyof PrintPartnerKyc]: null };

function toQueueRow(partner: Pick<PrintPartner, keyof typeof partnerSelect> & { kyc: PrintPartnerKyc | null }): PrintPartnerKycQueueRow {
  const { kyc, ...slice } = partner;
  const printPartner: PartnerSlice = slice;
  return {
    ...(kyc ?? EMPTY_RECORD),
    id: kyc?.id ?? partner.id,
    printPartnerId: partner.id,
    kycId: kyc?.id ?? null,
    state: deriveKycState(kyc, partner.kycStatus),
    printPartner,
  };
}

/** A decision clears the escalation — the case is answered, whoever it was handed to. */
const CLEAR_ESCALATION = { escalatedAt: null, escalationSource: null, escalationReason: null, escalatedToUserId: null, escalatedById: null } as const;

/** A status write and the partner's mirror, in one transaction. */
function writeWithMirror(id: string, data: Prisma.PrintPartnerKycUpdateInput, status: KycStatus) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.printPartnerKyc.update({ where: { id }, data, include: partnerInclude });
    await tx.printPartner.update({ where: { id: row.printPartnerId }, data: { kycStatus: status } });
    return { ...row, printPartner: { ...row.printPartner, kycStatus: status } };
  });
}

export const prismaPrintPartnerKycRepository: PrintPartnerKycRepository = {
  async findPage(where, page, pageSize, sort?: PrintPartnerKycSort) {
    // Late submissions first; N3-B: partners with nothing submitted follow, by
    // when the partner arrived; `newest` is the partner's arrival order.
    const orderBy: Prisma.PrintPartnerOrderByWithRelationInput[] =
      sort === 'newest' ? [{ createdAt: 'desc' }] : [{ kyc: { submittedAt: { sort: 'asc', nulls: 'last' } } }, { createdAt: 'asc' }];
    const [rows, total] = await Promise.all([
      prisma.printPartner.findMany({ where: partyWhere(where), skip: (page - 1) * pageSize, take: pageSize, orderBy, select: { ...partnerSelect, kyc: true } }),
      prisma.printPartner.count({ where: partyWhere(where) }),
    ]);
    return { items: rows.map(toQueueRow), total };
  },

  countBreached(where, cutoff) {
    return prisma.printPartner.count({ where: { AND: [partyWhere(where), { kyc: { is: { status: 'PENDING', submittedAt: { not: null, lt: cutoff } } } }] } });
  },

  async countByState(where) {
    const base: PrintPartnerKycFilter = { ...where, state: undefined, status: undefined, requested: undefined };
    const entries = await Promise.all(
      KYC_QUEUE_STATES.map(async (state) => [state, await prisma.printPartner.count({ where: partyWhere({ ...base, state }) })] as const),
    );
    return Object.fromEntries(entries) as Record<KycQueueState, number>;
  },

  countEscalated(where) {
    return prisma.printPartner.count({ where: { AND: [partyWhere({ ...where, escalated: undefined }), { kyc: { is: { escalatedAt: { not: null } } } }] } });
  },

  countRequested(where) {
    return prisma.printPartner.count({ where: partyWhere({ ...where, requested: undefined, status: undefined, state: 'REQUESTED' }) });
  },

  findById(id) {
    return prisma.printPartnerKyc.findUnique({ where: { id }, include: partnerInclude });
  },

  findByPartnerId(printPartnerId) {
    return prisma.printPartnerKyc.findUnique({ where: { printPartnerId }, include: partnerInclude });
  },

  findByDigioRequestId(kycId) {
    return prisma.printPartnerKyc.findFirst({ where: { digioRequestId: kycId }, include: partnerInclude });
  },

  findSummaries(printPartnerIds) {
    if (printPartnerIds.length === 0) return Promise.resolve([]);
    return prisma.printPartnerKyc.findMany({
      where: { printPartnerId: { in: [...printPartnerIds] } },
      select: { id: true, printPartnerId: true, status: true, submittedAt: true, method: true, requestedAt: true, requestedChannel: true },
    });
  },

  submit(printPartnerId, data, stamp, at) {
    return prisma.$transaction(async (tx) => {
      const row = await tx.printPartnerKyc.upsert({
        where: { printPartnerId },
        update: { ...data, status: 'PENDING', rejectionReason: null, submittedAt: at, ...stamp, ...CLEAR_ESCALATION },
        create: { printPartnerId, ...data, status: 'PENDING', submittedAt: at, ...stamp },
        include: partnerInclude,
      });
      await tx.printPartner.update({ where: { id: printPartnerId }, data: { kycStatus: 'PENDING' } });
      return { ...row, printPartner: { ...row.printPartner, kycStatus: 'PENDING' as const } };
    });
  },

  review(id, status, rejectionReason, stamp, at) {
    return writeWithMirror(
      id,
      { status, rejectionReason, reviewedAt: at, reviewedById: stamp.reviewedById, reviewNote: stamp.reviewNote ?? null, ...CLEAR_ESCALATION },
      status,
    );
  },

  requestReupload(id, stamp, at) {
    return writeWithMirror(id, { status: 'NEEDS_INFO', reviewedAt: at, reviewedById: stamp.reviewedById, reviewNote: stamp.reviewNote ?? null }, 'NEEDS_INFO');
  },

  async assign(id, adminUserId, at) {
    await prisma.printPartnerKyc.update({ where: { id }, data: { assignedToId: adminUserId, assignedAt: adminUserId ? at : null } });
  },

  markRequested(printPartnerId, stamp: RequestStamp) {
    return prisma.printPartnerKyc.upsert({
      where: { printPartnerId },
      update: stamp,
      create: { printPartnerId, ...stamp },
      include: partnerInclude,
    });
  },

  upsertDigio(printPartnerId, fields: DigioFields) {
    return prisma.printPartnerKyc.upsert({
      where: { printPartnerId },
      update: fields,
      create: { printPartnerId, ...fields },
      include: partnerInclude,
    });
  },

  applyDigioWebhook(id, update: DigioWebhookUpdate) {
    const { digioPayload, ...rest } = update;
    // Lot N: Digio's completion is the recording — nobody at ADX held the
    // documents. N2-B: an approval puts the row on the Digio path whatever
    // was sent by hand while the session was open.
    return writeWithMirror(
      id,
      { ...rest, digioPayload: digioPayload as Prisma.InputJsonValue, recordedById: null, ...(update.status === 'VERIFIED' ? { method: 'DIGIO' } : {}) },
      update.status,
    );
  },

  findPurgeable(cutoff, limit) {
    return prisma.printPartnerKyc.findMany({
      where: { method: 'DIGIO', status: 'VERIFIED', imagesPurgedAt: null, digioVerifiedAt: { not: null, lt: cutoff } },
      orderBy: { digioVerifiedAt: 'asc' },
      take: limit,
    });
  },

  purgeImages(id, data) {
    return prisma.printPartnerKyc.update({
      where: { id },
      data: {
        panFrontUrl: null,
        panSignatureUrl: null,
        gstUrl: null,
        businessRegCertUrl: null,
        businessAddressProofUrl: null,
        directorIdUrl: null,
        govIdFrontUrl: null,
        govIdBackUrl: null,
        bankProofUrl: null,
        selfieUrl: null,
        panNumber: data.panNumber,
        digioPayload: data.digioPayload === null ? Prisma.DbNull : (data.digioPayload as Prisma.InputJsonValue),
        imagesPurgedAt: new Date(),
      },
    });
  },
};
