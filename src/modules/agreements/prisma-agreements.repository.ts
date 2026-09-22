import { Prisma, prisma } from '../../shared/database';
import type { AgreementKind } from '../../shared/database';
import { pageArgs, toPage, type PageQuery } from '../../shared/pagination';
import type {
  AcceptanceAnchor,
  AcceptanceFilter,
  AcceptanceParty,
  AgreementsRepository,
  NewAcceptance,
  NewTemplate,
  PartySummary,
  PartyType,
  StaleParty,
  TemplatePatch,
  TemplateRow,
} from './agreements.repository';

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

const templateInclude = { _count: { select: { acceptances: true } } } as const;

type TemplateWithCount = Prisma.AgreementTemplateGetPayload<{ include: typeof templateInclude }>;

const shapeTemplate = ({ _count, ...row }: TemplateWithCount): TemplateRow => ({
  ...row,
  acceptanceCount: _count.acceptances,
});

const acceptanceInclude = {
  template: { select: { title: true } },
  acceptedBy: { select: { id: true, name: true, mobile: true } },
  publisher: { select: { id: true, displayId: true, name: true } },
  advertiser: { select: { id: true, displayId: true, name: true } },
} as const;

/** The columns both party tables share, which is all the lookup needs. */
const partySelect = {
  id: true,
  displayId: true,
  name: true,
  mobile: true,
  city: true,
  kycStatus: true,
  activatedAt: true,
  createdAt: true,
} as const;

type PartyColumns = Prisma.PublisherGetPayload<{ select: typeof partySelect }>;

const asParty =
  (type: PartyType) =>
  (row: PartyColumns): PartySummary => ({ type, ...row });

/** The party columns as a where clause: only the ones that are set. */
const partyWhere = (party: AcceptanceParty): Prisma.AgreementAcceptanceWhereInput => ({
  ...(party.publisherId ? { publisherId: party.publisherId } : {}),
  ...(party.advertiserId ? { advertiserId: party.advertiserId } : {}),
  ...(party.agentId ? { agentId: party.agentId } : {}),
});

const anchorWhere = (anchor: AcceptanceAnchor): Prisma.AgreementAcceptanceWhereInput => ({
  ...(anchor.attemptId ? { attemptId: anchor.attemptId } : {}),
  ...(anchor.campaignId ? { campaignId: anchor.campaignId } : {}),
  ...(anchor.packageSaleId ? { packageSaleId: anchor.packageSaleId } : {}),
  ...(anchor.orderId ? { orderId: anchor.orderId } : {}),
});

/* ------------------------------------------------------------------ */
/* Repository                                                          */
/* ------------------------------------------------------------------ */

export const prismaAgreementsRepository: AgreementsRepository = {
  /* Templates ------------------------------------------------------- */

  async listTemplates(kind?: AgreementKind) {
    const rows = await prisma.agreementTemplate.findMany({
      where: kind ? { kind } : {},
      include: templateInclude,
      orderBy: [{ kind: 'asc' }, { version: 'desc' }],
    });
    return rows.map(shapeTemplate);
  },

  async findTemplate(id: string) {
    const row = await prisma.agreementTemplate.findUnique({
      where: { id },
      include: templateInclude,
    });
    return row ? shapeTemplate(row) : null;
  },

  async activeTemplate(kind: AgreementKind) {
    const row = await prisma.agreementTemplate.findFirst({
      where: { kind, isActive: true },
      include: templateInclude,
      orderBy: { version: 'desc' },
    });
    return row ? shapeTemplate(row) : null;
  },

  async highestVersion(kind: AgreementKind) {
    const top = await prisma.agreementTemplate.findFirst({
      where: { kind },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return top?.version ?? 0;
  },

  async createTemplate(data: NewTemplate) {
    const row = await prisma.agreementTemplate.create({
      data: {
        kind: data.kind,
        version: data.version,
        title: data.title,
        body: data.body,
        changeNote: data.changeNote ?? null,
        createdByUserId: data.createdByUserId ?? null,
        requiresReacceptance: data.requiresReacceptance ?? false,
      },
      include: templateInclude,
    });
    return shapeTemplate(row);
  },

  async updateTemplate(id: string, patch: TemplatePatch) {
    const row = await prisma.agreementTemplate.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.changeNote !== undefined ? { changeNote: patch.changeNote } : {}),
        ...(patch.requiresReacceptance !== undefined
          ? { requiresReacceptance: patch.requiresReacceptance }
          : {}),
      },
      include: templateInclude,
    });
    return shapeTemplate(row);
  },

  async deleteTemplate(id: string) {
    await prisma.agreementTemplate.delete({ where: { id } });
  },

  async activateTemplate(id: string, kind: AgreementKind, at: Date, patch = {}) {
    const [, row] = await prisma.$transaction([
      prisma.agreementTemplate.updateMany({
        where: { kind, isActive: true, id: { not: id } },
        data: { isActive: false, retiredAt: at },
      }),
      prisma.agreementTemplate.update({
        where: { id },
        // effectiveFrom moves too: the terms take effect when they go live,
        // not when somebody started drafting them. E7-3: the re-acceptance
        // switch lands in the same statement, so there is no moment a version
        // is live with the wrong gate.
        data: {
          isActive: true,
          activatedAt: at,
          retiredAt: null,
          effectiveFrom: at,
          ...(patch.requiresReacceptance !== undefined ? { requiresReacceptance: patch.requiresReacceptance } : {}),
        },
        include: templateInclude,
      }),
    ]);
    return shapeTemplate(row);
  },

  /* Acceptances ----------------------------------------------------- */

  async listAcceptances(filter: AcceptanceFilter, page: PageQuery = {}) {
    const where: Prisma.AgreementAcceptanceWhereInput = {
      ...(filter.publisherId ? { publisherId: filter.publisherId } : {}),
      ...(filter.advertiserId ? { advertiserId: filter.advertiserId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
      ...(filter.templateId ? { templateId: filter.templateId } : {}),
      ...(filter.kind ? { templateKind: filter.kind } : {}),
      // E7-3: the transaction anchors.
      ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
      ...(filter.orderId ? { orderId: filter.orderId } : {}),
      ...(filter.packageSaleId ? { packageSaleId: filter.packageSaleId } : {}),
      ...(filter.attemptId ? { attemptId: filter.attemptId } : {}),
    };
    const rows = await prisma.agreementAcceptance.findMany({
      where,
      include: acceptanceInclude,
      orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(page),
    });
    return toPage(rows, page);
  },

  countAcceptances(filter: AcceptanceFilter) {
    return prisma.agreementAcceptance.count({
      where: {
        ...(filter.publisherId ? { publisherId: filter.publisherId } : {}),
        ...(filter.advertiserId ? { advertiserId: filter.advertiserId } : {}),
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
        ...(filter.templateId ? { templateId: filter.templateId } : {}),
        ...(filter.kind ? { templateKind: filter.kind } : {}),
      },
    });
  },

  findPlatformAcceptance(kind: AgreementKind, party: AcceptanceParty) {
    return prisma.agreementAcceptance.findFirst({
      where: {
        templateKind: kind,
        ...partyWhere(party),
        // Platform scope is the acceptance with no transaction behind it.
        attemptId: null,
        campaignId: null,
        packageSaleId: null,
        orderId: null,
      },
      orderBy: [{ templateVersion: 'desc' }, { acceptedAt: 'desc' }],
    });
  },

  findAnchoredAcceptance(kind: AgreementKind, anchor: AcceptanceAnchor) {
    return prisma.agreementAcceptance.findFirst({
      where: { templateKind: kind, ...anchorWhere(anchor) },
      orderBy: [{ templateVersion: 'desc' }, { acceptedAt: 'desc' }],
    });
  },

  createAcceptance(data: NewAcceptance) {
    return prisma.agreementAcceptance.create({
      data: {
        templateId: data.templateId,
        templateKind: data.templateKind,
        templateVersion: data.templateVersion,
        publisherId: data.publisherId ?? null,
        advertiserId: data.advertiserId ?? null,
        agentId: data.agentId ?? null,
        attemptId: data.attemptId ?? null,
        campaignId: data.campaignId ?? null,
        packageSaleId: data.packageSaleId ?? null,
        orderId: data.orderId ?? null,
        acceptedByUserId: data.acceptedByUserId,
        ipAddress: data.ipAddress ?? null,
        userAgent: data.userAgent ?? null,
        renderedDocument: data.renderedDocument ?? null,
        ...(data.signatureProvider ? { signatureProvider: data.signatureProvider } : {}),
        ...(data.signatureRef !== undefined ? { signatureRef: data.signatureRef } : {}),
      },
    });
  },

  markAcceptanceSigned(id, signatureRef) {
    return prisma.agreementAcceptance.update({ where: { id }, data: { signatureProvider: 'DIGIO', signatureRef } });
  },

  async partiesBehind(kind: AgreementKind, currentVersion: number) {
    // The highest version each party ever accepted of this kind; anyone whose
    // highest is below the live one is behind. Grouped in the database so a
    // book of thousands of publishers is one query, not one per party.
    const groups = await prisma.agreementAcceptance.groupBy({
      by: ['publisherId', 'advertiserId', 'agentId'],
      where: { templateKind: kind, attemptId: null, campaignId: null, packageSaleId: null, orderId: null },
      _max: { templateVersion: true },
    });
    const behind = groups.filter((group) => (group._max.templateVersion ?? 0) < currentVersion);
    const publisherIds = behind.map((g) => g.publisherId).filter((id): id is string => Boolean(id));
    const advertiserIds = behind.map((g) => g.advertiserId).filter((id): id is string => Boolean(id));
    const names = { id: true, displayId: true, name: true } as const;
    const [publishers, advertisers] = await Promise.all([
      publisherIds.length ? prisma.publisher.findMany({ where: { id: { in: publisherIds } }, select: names }) : [],
      advertiserIds.length ? prisma.advertiser.findMany({ where: { id: { in: advertiserIds } }, select: names }) : [],
    ]);
    const byId = new Map<string, { type: PartyType; displayId: string | null; name: string }>();
    for (const row of publishers) byId.set(row.id, { type: 'publisher', displayId: row.displayId, name: row.name });
    for (const row of advertisers) byId.set(row.id, { type: 'advertiser', displayId: row.displayId, name: row.name });
    const rows: StaleParty[] = [];
    for (const group of behind) {
      const id = group.publisherId ?? group.advertiserId;
      if (!id) continue;
      const party = byId.get(id);
      if (!party) continue;
      rows.push({ ...party, id, acceptedVersion: group._max.templateVersion ?? 0 });
    }
    return rows.sort((a, b) => a.acceptedVersion - b.acceptedVersion || a.name.localeCompare(b.name));
  },

  /* Campaigns -------------------------------------------------------- */

  async campaignForInsertionOrder(campaignId: string) {
    const row = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        reference: true,
        name: true,
        advertiserId: true,
        startDate: true,
        endDate: true,
        advertiser: { select: { name: true, companyName: true } },
        spots: {
          where: { status: { not: 'CANCELLED' } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            ratePerDay: true,
            days: true,
            quantity: true,
            lineTotal: true,
            listing: { select: { title: true, city: true } },
          },
        },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      reference: row.reference,
      name: row.name,
      advertiserId: row.advertiserId,
      advertiserName: row.advertiser.companyName ?? row.advertiser.name,
      startDate: row.startDate,
      endDate: row.endDate,
      spots: row.spots.map((spot) => ({
        id: spot.id,
        title: spot.listing.title,
        city: spot.listing.city,
        ratePerDay: spot.ratePerDay.toFixed(2),
        days: spot.days,
        quantity: spot.quantity,
        lineTotal: spot.lineTotal.toFixed(2),
      })),
    };
  },

  /* Parties --------------------------------------------------------- */

  async searchParties(query: string, limitPerType: number) {
    const text = { contains: query, mode: 'insensitive' as const };
    // Mobiles are stored normalised (+91…), so a plain contains is enough for
    // somebody typing the last few digits off a support ticket.
    const match = { OR: [{ displayId: text }, { name: text }, { mobile: { contains: query } }] };
    const [publishers, advertisers] = await Promise.all([
      prisma.publisher.findMany({
        where: match,
        select: partySelect,
        orderBy: { createdAt: 'desc' },
        take: limitPerType,
      }),
      prisma.advertiser.findMany({
        where: match,
        select: partySelect,
        orderBy: { createdAt: 'desc' },
        take: limitPerType,
      }),
    ]);
    return [...publishers.map(asParty('publisher')), ...advertisers.map(asParty('advertiser'))];
  },

  async findParty(type: PartyType, id: string) {
    if (type === 'agent') {
      // Lot D: an agent signs JOB_TERMS. No KYC status or activation on the
      // profile itself — the columns the summary carries are read as the
      // agents module presents them: the person's name and mobile, the city.
      const agent = await prisma.agentProfile.findUnique({
        where: { id },
        select: {
          id: true,
          displayId: true,
          city: true,
          createdAt: true,
          user: { select: { name: true, mobile: true } },
          kyc: { select: { status: true } },
        },
      });
      if (!agent) return null;
      return {
        type,
        id: agent.id,
        displayId: agent.displayId,
        name: agent.user.name ?? agent.user.mobile,
        mobile: agent.user.mobile,
        city: agent.city,
        kycStatus: agent.kyc?.status ?? 'PENDING',
        activatedAt: null,
        createdAt: agent.createdAt,
      };
    }
    const row =
      type === 'publisher'
        ? await prisma.publisher.findUnique({ where: { id }, select: partySelect })
        : await prisma.advertiser.findUnique({ where: { id }, select: partySelect });
    return row ? asParty(type)(row) : null;
  },
};
