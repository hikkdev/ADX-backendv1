import { Prisma, prisma } from '../../shared/database';
import type { PublisherImportStatus } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import { boundingBox } from '../../shared/geo';
import { money } from '../../shared/money';
import { slotHoldingOrdersWhere } from '../listings';
import { IMPORT_STATUSES } from './party-imports.schema';
import type { MatchSet, MatchedListing, MatchedParty, NearbyListing, PartyImportsRepository } from './party-imports.repository';

const withRows = { rows: { orderBy: { rowNumber: 'asc' as const } } } as const;

const emptyMatch = (): MatchSet => ({ byMobile: [], byPan: new Map(), byGstin: new Map(), blockedMobiles: new Map(), takenEmails: new Map() });

const text = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));

/** Emails already on a User, by that User's mobile — the create of an agent, a partner or an employee is refused for one held by someone else. */
async function takenEmails(emails: string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const rows = await prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true, mobile: true } });
  return new Map(rows.filter((row): row is { email: string; mobile: string } => Boolean(row.email)).map((row) => [row.email, row.mobile]));
}

export const prismaPartyImportsRepository: PartyImportsRepository = {
  createImport({ party, fileName, note, uploadedById, publisherId, rows, counts }) {
    return prisma.partyImport.create({
      data: {
        party,
        fileName,
        note,
        uploadedById,
        publisherId: publisherId ?? null,
        status: 'VALIDATED',
        ...counts,
        rows: {
          create: rows.map((row) => ({
            rowNumber: row.rowNumber,
            data: row.data as Prisma.InputJsonValue,
            outcome: row.outcome,
            targetId: row.targetId,
            message: row.message,
          })),
        },
      },
      include: withRows,
    });
  },

  async listImports(party, query) {
    const scope: Prisma.PartyImportWhereInput = { party, ...(query.publisherId ? { publisherId: query.publisherId } : {}) };
    const where: Prisma.PartyImportWhereInput = { ...scope, ...(query.status?.length ? { status: { in: query.status as PublisherImportStatus[] } } : {}) };
    const [items, total, groups] = await Promise.all([
      prisma.partyImport.findMany({ where, orderBy: { createdAt: 'desc' }, ...listArgs(query) }),
      prisma.partyImport.count({ where }),
      prisma.partyImport.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize, counts: countsFrom(groups, IMPORT_STATUSES) };
  },

  findImport(party, id) {
    return prisma.partyImport.findFirst({ where: { id, party }, include: withRows });
  },

  async stampRow(rowId, stamp) {
    await prisma.partyImportRow.update({
      where: { id: rowId },
      data: {
        ...(stamp.outcome !== undefined ? { outcome: stamp.outcome } : {}),
        ...(stamp.targetId !== undefined ? { targetId: stamp.targetId } : {}),
        ...(stamp.message !== undefined ? { message: stamp.message } : {}),
        ...(stamp.data !== undefined ? { data: stamp.data as Prisma.InputJsonValue } : {}),
      },
    });
  },

  finishCommit(id, counts, committedAt) {
    return prisma.partyImport.update({ where: { id }, data: { status: 'COMMITTED', committedAt, ...counts }, include: withRows });
  },

  setStatus(id, status) {
    return prisma.partyImport.update({ where: { id }, data: { status }, include: withRows });
  },

  async setAttempt(id, attemptId) {
    await prisma.partyImport.update({ where: { id }, data: { attemptId } });
  },

  /* ── The parties' tables, read only ─────────────────────────────────── */

  async matchAdvertisers({ mobiles, pans, gstins }) {
    const select = {
      id: true,
      displayId: true,
      mobile: true,
      name: true,
      email: true,
      type: true,
      companyName: true,
      industry: true,
      gstin: true,
      billingAddress: true,
      city: true,
      state: true,
      kyc: { select: { panNumber: true } },
    } as const;
    type Row = Prisma.AdvertiserGetPayload<{ select: typeof select }>;
    const toMatch = (row: Row): MatchedParty => ({
      id: row.id,
      displayId: row.displayId,
      mobile: row.mobile,
      label: row.companyName ?? row.name,
      fields: {
        name: text(row.name),
        email: text(row.email),
        type: text(row.type),
        companyName: text(row.companyName),
        industry: text(row.industry),
        gstin: text(row.gstin),
        address: text(row.billingAddress),
        city: text(row.city),
        state: text(row.state),
        panNumber: text(row.kyc?.panNumber),
      },
    });
    const [byMobile, byPan, byGstin] = await Promise.all([
      mobiles.length ? prisma.advertiser.findMany({ where: { mobile: { in: mobiles } }, select }) : [],
      pans.length ? prisma.advertiser.findMany({ where: { kyc: { is: { panNumber: { in: pans } } } }, select }) : [],
      gstins.length ? prisma.advertiser.findMany({ where: { gstin: { in: gstins } }, select }) : [],
    ]);
    return {
      ...emptyMatch(),
      byMobile: byMobile.map(toMatch),
      byPan: new Map(byPan.map((row) => [row.kyc?.panNumber ?? '', toMatch(row)])),
      byGstin: new Map(byGstin.map((row) => [row.gstin ?? '', toMatch(row)])),
    };
  },

  async matchAgents({ mobiles, emails }) {
    const rows = mobiles.length
      ? await prisma.agentProfile.findMany({
          where: { user: { mobile: { in: mobiles } } },
          select: { id: true, displayId: true, city: true, state: true, user: { select: { mobile: true, name: true, email: true } } },
        })
      : [];
    return {
      ...emptyMatch(),
      byMobile: rows.map((row) => ({
        id: row.id,
        displayId: row.displayId,
        mobile: row.user.mobile,
        label: row.user.name ?? row.user.mobile,
        fields: { name: text(row.user.name), email: text(row.user.email), city: text(row.city), state: text(row.state) },
      })),
      takenEmails: await takenEmails(emails),
    };
  },

  async matchPrintPartners({ mobiles, pans, gstins, emails }) {
    const select = {
      id: true,
      userId: true,
      displayId: true,
      mobile: true,
      name: true,
      legalName: true,
      gstin: true,
      panNumber: true,
      contactName: true,
      email: true,
      address: true,
      city: true,
      capabilities: true,
      maxWidthFt: true,
      turnaroundDays: true,
    } as const;
    type Row = Prisma.PrintPartnerGetPayload<{ select: typeof select }>;
    const toMatch = (row: Row): MatchedParty => ({
      id: row.id,
      displayId: row.displayId,
      mobile: row.mobile,
      label: row.name,
      fields: {
        name: text(row.name),
        legalName: text(row.legalName),
        gstin: text(row.gstin),
        panNumber: text(row.panNumber),
        contactName: text(row.contactName),
        email: text(row.email),
        address: text(row.address),
        city: text(row.city),
        capabilities: row.capabilities.length ? row.capabilities.join('|') : null,
        maxWidthFt: row.maxWidthFt ? row.maxWidthFt.toString() : null,
        turnaroundDays: row.turnaroundDays === null ? null : String(row.turnaroundDays),
      },
    });
    const [byMobile, byPan, byGstin, users] = await Promise.all([
      mobiles.length ? prisma.printPartner.findMany({ where: { mobile: { in: mobiles } }, select }) : [],
      pans.length ? prisma.printPartner.findMany({ where: { panNumber: { in: pans } }, select }) : [],
      gstins.length ? prisma.printPartner.findMany({ where: { gstin: { in: gstins } }, select }) : [],
      mobiles.length ? prisma.user.findMany({ where: { mobile: { in: mobiles } }, select: { id: true, mobile: true } }) : [],
    ]);
    // A partner account is never attached to an existing person (createPartner
    // refuses it): a number on a User that is not a partner cannot be created.
    const partnerUserIds = new Set(byMobile.map((row) => row.userId));
    const blockedMobiles = new Map<string, string>();
    for (const user of users) {
      if (!partnerUserIds.has(user.id)) blockedMobiles.set(user.mobile, 'mobile already belongs to an ADX account; a print partner needs its own number');
    }
    return {
      byMobile: byMobile.map(toMatch),
      byPan: new Map(byPan.map((row) => [row.panNumber ?? '', toMatch(row)])),
      byGstin: new Map(byGstin.map((row) => [row.gstin ?? '', toMatch(row)])),
      blockedMobiles,
      takenEmails: await takenEmails(emails),
    };
  },

  async matchEmployees({ mobiles, emails }) {
    const rows = mobiles.length
      ? await prisma.employee.findMany({
          where: { user: { mobile: { in: mobiles } } },
          select: {
            id: true,
            userId: true,
            displayId: true,
            department: true,
            designation: true,
            region: true,
            workMode: true,
            employmentType: true,
            user: { select: { mobile: true, name: true, email: true } },
          },
        })
      : [];
    return {
      ...emptyMatch(),
      byMobile: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        displayId: row.displayId,
        mobile: row.user.mobile,
        label: row.user.name ?? row.user.mobile,
        fields: {
          name: text(row.user.name),
          email: text(row.user.email),
          department: text(row.department),
          designation: text(row.designation),
          region: text(row.region),
          workMode: text(row.workMode),
          employmentType: text(row.employmentType),
        },
      })),
      takenEmails: await takenEmails(emails),
    };
  },

  async findUserByMobile(mobile) {
    const user = await prisma.user.findUnique({ where: { mobile }, select: { id: true, employeeProfile: { select: { id: true } } } });
    return user ? { id: user.id, employeeId: user.employeeProfile?.id ?? null } : null;
  },

  /* ── Lot U: the publisher's spots and rate card, read only ─────────── */

  findPublisher(publisherId) {
    return prisma.publisher.findUnique({ where: { id: publisherId }, select: { id: true, displayId: true, name: true, agentId: true, userId: true } });
  },

  async listPublisherListings(publisherId) {
    const rows = await prisma.listing.findMany({
      where: { publisherId, status: { notIn: ['INACTIVE', 'REJECTED'] } },
      select: {
        id: true,
        displayId: true,
        title: true,
        address: true,
        latitude: true,
        longitude: true,
        ratePerDay: true,
        slotsTotal: true,
        status: true,
        subType: true,
        description: true,
        city: true,
        size: true,
        mediaTypeId: true,
        sizeClassId: true,
        materialId: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(
      (row): MatchedListing => ({
        id: row.id,
        displayId: row.displayId,
        title: row.title,
        address: row.address,
        latitude: row.latitude,
        longitude: row.longitude,
        ratePerDay: row.ratePerDay === null ? null : money(row.ratePerDay.toString()),
        slotsTotal: row.slotsTotal ?? 1,
        status: row.status,
        fields: {
          subType: text(row.subType),
          description: text(row.description),
          city: text(row.city),
          size: text(row.size),
          mediaTypeId: text(row.mediaTypeId),
          sizeClassId: text(row.sizeClassId),
          materialId: text(row.materialId),
        },
      }),
    );
  },

  async findExternalRefs(publisherId) {
    // The platform has no column for the publisher's own reference; the rows
    // of the LISTING imports already committed for this publisher are where
    // it was last seen, beside the listing each row created or merged into.
    const rows = await prisma.partyImportRow.findMany({
      where: { targetId: { not: null }, import: { party: 'LISTING', publisherId, status: 'COMMITTED' } },
      select: { targetId: true, data: true },
      orderBy: { import: { committedAt: 'asc' } },
    });
    const refs = new Map<string, string>();
    for (const row of rows) {
      const ref = (row.data as { externalRef?: unknown } | null)?.externalRef;
      if (typeof ref === 'string' && ref !== '' && row.targetId) refs.set(ref, row.targetId);
    }
    return refs;
  },

  async findListingsNear(points, excludePublisherId, radiusM) {
    if (points.length === 0) return [];
    const found = new Map<string, NearbyListing>();
    // Two hundred boxes a query: a five-thousand-row batch is twenty-five reads, not one unbounded OR.
    for (let start = 0; start < points.length; start += 200) {
      const boxes = points.slice(start, start + 200).map((point) => {
        const { latDelta, lngDelta } = boundingBox(point.latitude, radiusM);
        return {
          latitude: { gte: point.latitude - latDelta, lte: point.latitude + latDelta },
          longitude: { gte: point.longitude - lngDelta, lte: point.longitude + lngDelta },
        };
      });
      const rows = await prisma.listing.findMany({
        where: { OR: boxes, publisherId: { not: excludePublisherId }, status: { notIn: ['INACTIVE', 'REJECTED'] } },
        select: { id: true, displayId: true, title: true, publisherId: true, latitude: true, longitude: true },
        take: 2000,
      });
      for (const row of rows) {
        if (row.latitude === null || row.longitude === null) continue;
        found.set(row.id, { id: row.id, displayId: row.displayId, title: row.title, publisherId: row.publisherId, latitude: row.latitude, longitude: row.longitude });
      }
    }
    return [...found.values()];
  },

  async listSpotVocabulary() {
    const [mediaTypes, sizeClasses, materials] = await Promise.all([
      prisma.mediaType.findMany({ where: { status: 'ACTIVE' }, select: { id: true, name: true, slug: true, category: true }, orderBy: { name: 'asc' } }),
      prisma.sizeClass.findMany({ select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } }),
      prisma.material.findMany({ where: { isActive: true }, select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } }),
    ]);
    return { mediaTypes, sizeClasses, materials };
  },

  async findCityIdByName(name) {
    const city = await prisma.city.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    return city?.id ?? null;
  },

  async listingsWithRunningBooking(listingIds, now = new Date()) {
    if (listingIds.length === 0) return new Set();
    const rows = await prisma.order.findMany({
      where: { listingId: { in: listingIds }, ...slotHoldingOrdersWhere({ from: now, to: now }) },
      select: { listingId: true },
      distinct: ['listingId'],
    });
    return new Set(rows.map((row) => row.listingId));
  },
};
