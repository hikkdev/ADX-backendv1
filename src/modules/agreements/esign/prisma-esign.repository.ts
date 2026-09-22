import { Prisma, prisma } from '../../../shared/database';
import type { AgreementKind, SigningParty } from '../../../shared/database';
import { pageArgs, toPage, type PageQuery } from '../../../shared/pagination';
import type { EsignRepository, NewSigningRequest, PartySigner, SignerState, SigningFilter, SigningPatch, SigningRow } from './esign.repository';

const include = { template: { select: { title: true, version: true } } } as const;

const json = (value: unknown) => (value === undefined ? undefined : value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue));

const GRADE_LABEL: Record<string, string> = { G1: 'Grade 1 — Entry', G2: 'Grade 2 — Senior field', G3: 'Grade 3 — Key accounts', G4: 'Grade 4 — Enterprise' };
const BAND_LABEL: Record<string, string> = { INDIVIDUAL: 'Individual', SMALL_AGENCY: 'Small agency', LARGE_AGENCY: 'Large agency' };

export const prismaEsignRepository: EsignRepository = {
  async create(data) {
    const { signers, followUp, providerPayload, stampAmount, ...rest } = data;
    return prisma.signingRequest.create({
      data: {
        ...rest,
        signers: signers as unknown as Prisma.InputJsonValue,
        ...(followUp !== undefined ? { followUp: json(followUp) } : {}),
        ...(providerPayload !== undefined ? { providerPayload: json(providerPayload) } : {}),
        ...(stampAmount !== undefined && stampAmount !== null ? { stampAmount: new Prisma.Decimal(stampAmount) } : {}),
      },
      include,
    });
  },

  async patch(id, patch) {
    const { signers, providerPayload, ...rest } = patch;
    return prisma.signingRequest.update({
      where: { id },
      data: {
        ...rest,
        ...(signers !== undefined ? { signers: signers as unknown as Prisma.InputJsonValue } : {}),
        ...(providerPayload !== undefined ? { providerPayload: json(providerPayload) } : {}),
      },
      include,
    });
  },

  find: (id) => prisma.signingRequest.findUnique({ where: { id }, include }),

  findByProviderRef: (providerRef) => prisma.signingRequest.findUnique({ where: { providerRef }, include }),

  latestFor: (partyType, partyId, kind, anchor) =>
    prisma.signingRequest.findFirst({
      where: {
        partyType,
        partyId,
        kind,
        ...(anchor?.campaignId ? { campaignId: anchor.campaignId } : {}),
        ...(anchor?.attemptId ? { attemptId: anchor.attemptId } : {}),
      },
      orderBy: { requestedAt: 'desc' },
      include,
    }),

  async list(filter, page) {
    const where: Prisma.SigningRequestWhereInput = {
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.partyType ? { partyType: filter.partyType } : {}),
      ...(filter.partyId ? { partyId: filter.partyId } : {}),
      ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
      ...(filter.q
        ? {
            OR: [
              { signerName: { contains: filter.q, mode: 'insensitive' } },
              { signerIdentifier: { contains: filter.q, mode: 'insensitive' } },
              { partyId: filter.q },
              { providerRef: filter.q },
            ],
          }
        : {}),
    };
    const rows = await prisma.signingRequest.findMany({ where, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], include, ...pageArgs(page) });
    return toPage(rows, page);
  },

  async listForUser(userId) {
    const parties = await this.partiesOfUser(userId);
    if (parties.length === 0) return [];
    return prisma.signingRequest.findMany({
      where: { OR: parties.map((p) => ({ partyType: p.partyType, partyId: p.partyId })) },
      orderBy: { requestedAt: 'desc' },
      include,
    });
  },

  expiredOpen: (now, limit) =>
    prisma.signingRequest.findMany({
      where: { status: { in: ['REQUESTED', 'PARTIALLY_SIGNED'] }, expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      include,
    }),

  async partySigner(partyType, partyId): Promise<PartySigner | null> {
    if (partyType === 'PUBLISHER') {
      const row = await prisma.publisher.findUnique({
        where: { id: partyId },
        select: { id: true, displayId: true, name: true, contactName: true, mobile: true, email: true, userId: true, city: true, state: true, sizeBand: true, gstin: true, type: true, cityRef: { select: { state: true } } },
      });
      if (!row) return null;
      return {
        partyType,
        partyId: row.id,
        displayId: row.displayId,
        partyName: row.name,
        signerName: row.contactName ?? row.name,
        signerUserId: row.userId,
        email: row.email,
        mobile: row.mobile,
        state: row.state ?? row.cityRef?.state ?? null,
        city: row.city,
        band: row.sizeBand,
        fields: { 'party.type': row.type, 'party.gstin': row.gstin ?? '', 'party.band': BAND_LABEL[row.sizeBand] ?? row.sizeBand },
      };
    }
    if (partyType === 'ADVERTISER') {
      const row = await prisma.advertiser.findUnique({
        where: { id: partyId },
        select: { id: true, displayId: true, name: true, companyName: true, mobile: true, email: true, userId: true, city: true, state: true, sizeBand: true, gstin: true, type: true, cityRef: { select: { state: true } } },
      });
      if (!row) return null;
      return {
        partyType,
        partyId: row.id,
        displayId: row.displayId,
        partyName: row.companyName ?? row.name,
        signerName: row.name,
        signerUserId: row.userId,
        email: row.email,
        mobile: row.mobile,
        state: row.state ?? row.cityRef?.state ?? null,
        city: row.city,
        band: row.sizeBand,
        fields: { 'party.type': row.type, 'party.gstin': row.gstin ?? '', 'party.band': BAND_LABEL[row.sizeBand] ?? row.sizeBand, 'party.company': row.companyName ?? '' },
      };
    }
    if (partyType === 'AGENT') {
      const row = await prisma.agentProfile.findUnique({
        where: { id: partyId },
        select: { id: true, displayId: true, city: true, state: true, grade: true, engagementType: true, engagementStartAt: true, cityRef: { select: { state: true } }, user: { select: { id: true, name: true, mobile: true, email: true, roles: { select: { role: true } } } } },
      });
      if (!row) return null;
      const side = row.user.roles.some((r) => r.role === 'AGENT_ADVERTISER') ? 'Sales agent' : 'Field agent';
      return {
        partyType,
        partyId: row.id,
        displayId: row.displayId,
        partyName: row.user.name ?? row.user.mobile,
        signerName: row.user.name ?? row.user.mobile,
        signerUserId: row.user.id,
        email: row.user.email,
        mobile: row.user.mobile,
        state: row.state ?? row.cityRef?.state ?? null,
        city: row.city,
        band: null,
        fields: {
          'agent.side': side,
          'agent.grade': row.grade ? (GRADE_LABEL[row.grade] ?? row.grade) : '',
          'agent.engagement': row.engagementType ?? '',
          'agent.startDate': row.engagementStartAt ? row.engagementStartAt.toISOString().slice(0, 10) : '',
        },
      };
    }
    if (partyType === 'EMPLOYEE') {
      const row = await prisma.employee.findUnique({
        where: { id: partyId },
        select: { id: true, displayId: true, designation: true, department: true, employmentType: true, region: true, user: { select: { id: true, name: true, mobile: true, email: true } } },
      });
      if (!row) return null;
      return {
        partyType,
        partyId: row.id,
        displayId: row.displayId,
        partyName: row.user.name ?? row.user.mobile,
        signerName: row.user.name ?? row.user.mobile,
        signerUserId: row.user.id,
        email: row.user.email,
        mobile: row.user.mobile,
        state: null,
        city: row.region,
        band: null,
        fields: { 'employee.designation': row.designation ?? '', 'employee.department': row.department ?? '', 'employee.employmentType': row.employmentType ?? '' },
      };
    }
    const row = await prisma.printPartner.findUnique({
      where: { id: partyId },
      select: { id: true, displayId: true, name: true, legalName: true, contactName: true, mobile: true, email: true, userId: true, city: true, gstin: true, panNumber: true, cityRef: { select: { state: true } } },
    });
    if (!row) return null;
    return {
      partyType,
      partyId: row.id,
      displayId: row.displayId,
      partyName: row.legalName ?? row.name,
      signerName: row.contactName ?? row.name,
      signerUserId: row.userId,
      email: row.email,
      mobile: row.mobile,
      state: row.cityRef?.state ?? null,
      city: row.city,
      band: null,
      fields: { 'party.gstin': row.gstin ?? '', 'party.pan': row.panNumber ?? '', 'party.tradeName': row.name },
    };
  },

  async partiesOfUser(userId) {
    const [publisher, advertiser, agent, employee, partner] = await Promise.all([
      prisma.publisher.findUnique({ where: { userId }, select: { id: true } }),
      prisma.advertiser.findUnique({ where: { userId }, select: { id: true } }),
      prisma.agentProfile.findUnique({ where: { userId }, select: { id: true } }),
      prisma.employee.findUnique({ where: { userId }, select: { id: true } }),
      prisma.printPartner.findUnique({ where: { userId }, select: { id: true } }),
    ]);
    const out: { partyType: SigningParty; partyId: string }[] = [];
    if (publisher) out.push({ partyType: 'PUBLISHER', partyId: publisher.id });
    if (advertiser) out.push({ partyType: 'ADVERTISER', partyId: advertiser.id });
    if (agent) out.push({ partyType: 'AGENT', partyId: agent.id });
    if (employee) out.push({ partyType: 'EMPLOYEE', partyId: employee.id });
    if (partner) out.push({ partyType: 'PRINT_PARTNER', partyId: partner.id });
    return out;
  },

  async publisherListings(publisherId) {
    const rows = await prisma.listing.findMany({
      where: { publisherId, status: { in: ['AWAITING_SITE_VERIFICATION', 'ACTIVE', 'SUSPENDED'] } },
      orderBy: { createdAt: 'asc' },
      select: { displayId: true, title: true, city: true },
      take: 500,
    });
    return rows.map((r) => ({ reference: r.displayId, title: r.title, city: r.city }));
  },
};

export type { SignerState, SigningRow, SigningFilter, SigningPatch, NewSigningRequest, AgreementKind };
