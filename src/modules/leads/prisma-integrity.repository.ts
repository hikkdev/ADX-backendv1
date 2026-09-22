import { prisma } from '../../shared/database';
import type {
  CallSample,
  ClawbackCandidate,
  FlagWithLead,
  LeadIntegrityRepository,
  NewFlag,
  NewQaSample,
  PhoneTwin,
  ReferralFact,
  ScanLead,
  VisitSample,
} from './integrity.repository';

/** LH10: the integrity scan, the QA sampling and the clawback watch, over Prisma. */

const HOUR_MS = 60 * 60 * 1000;

export const prismaIntegrityRepository: LeadIntegrityRepository = {
  async leadsCreatedSince(since, take) {
    const rows = await prisma.lead.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true, displayId: true, businessName: true, phoneNormalised: true, capturedByAgentId: true, capturedAt: true, assignedAgentId: true, externalKey: true, createdAt: true },
    });
    return rows as ScanLead[];
  },

  async leadsWithPhone(phoneNormalised, excludeLeadId) {
    // The normalised column is unique where it is set, so a twin is either a
    // row whose number never normalised (the raw string carries the digits)
    // or — impossible today — a second normalised row. Both are asked for.
    const digits = phoneNormalised.replace(/\D/g, '').slice(-10);
    const rows = await prisma.lead.findMany({
      where: {
        id: { not: excludeLeadId },
        OR: [{ phoneNormalised }, ...(digits.length === 10 ? [{ phoneNormalised: null, phone: { contains: digits } }] : [])],
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { id: true, displayId: true, businessName: true, createdAt: true },
    });
    return rows as PhoneTwin[];
  },

  async accountsWithPhone(phoneNormalised) {
    const [publishers, advertisers] = await Promise.all([
      prisma.publisher.findMany({ where: { mobile: phoneNormalised }, select: { id: true, name: true }, take: 5 }),
      prisma.advertiser.findMany({ where: { mobile: phoneNormalised }, select: { id: true, name: true, companyName: true }, take: 5 }),
    ]);
    return [
      ...publishers.map((row) => ({ kind: 'PUBLISHER', id: row.id, name: row.name })),
      ...advertisers.map((row) => ({ kind: 'ADVERTISER', id: row.id, name: row.companyName ?? row.name })),
    ];
  },

  async referralFor(leadId) {
    const row = await prisma.leadReferral.findUnique({
      where: { leadId },
      select: { id: true, referrerKind: true, referrerId: true, creditedAt: true },
    });
    if (!row) return null;
    // The referrer's own handles, from whichever party table holds them.
    const party =
      row.referrerKind === 'PUBLISHER'
        ? await prisma.publisher.findUnique({ where: { id: row.referrerId }, select: { name: true, mobile: true, userId: true } })
        : row.referrerKind === 'ADVERTISER'
          ? await prisma.advertiser.findUnique({ where: { id: row.referrerId }, select: { name: true, mobile: true, userId: true } })
          : await prisma.agentProfile.findUnique({ where: { id: row.referrerId }, select: { userId: true, user: { select: { name: true, mobile: true } } } });
    const name = party && 'name' in party ? party.name : (party as { user?: { name: string | null } } | null)?.user?.name ?? null;
    const phone = party && 'mobile' in party ? party.mobile : (party as { user?: { mobile: string | null } } | null)?.user?.mobile ?? null;
    return {
      id: row.id,
      referrerKind: row.referrerKind,
      referrerId: row.referrerId,
      referrerName: name ?? null,
      referrerPhone: phone ?? null,
      referrerUserId: party?.userId ?? null,
      creditedAt: row.creditedAt,
    } satisfies ReferralFact;
  },

  async deviceTokensFor(userId) {
    const rows = await prisma.deviceToken.findMany({ where: { userId }, select: { token: true }, take: 20 });
    return rows.map((row) => row.token);
  },

  async userIdsWithDeviceTokens(tokens, excludeUserId) {
    if (tokens.length === 0) return [];
    const rows = await prisma.deviceToken.findMany({
      where: { token: { in: tokens }, ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) },
      select: { userId: true },
      take: 50,
    });
    return [...new Set(rows.map((row) => row.userId))];
  },

  async userIdForLead(leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { convertedPublisherId: true, convertedAdvertiserId: true } });
    if (!lead) return null;
    if (lead.convertedPublisherId) return (await prisma.publisher.findUnique({ where: { id: lead.convertedPublisherId }, select: { userId: true } }))?.userId ?? null;
    if (lead.convertedAdvertiserId) return (await prisma.advertiser.findUnique({ where: { id: lead.convertedAdvertiserId }, select: { userId: true } }))?.userId ?? null;
    return null;
  },

  async capturesInHour(agentId, at) {
    const rows = await prisma.lead.findMany({
      where: { capturedByAgentId: agentId, capturedAt: { gte: new Date(at.getTime() - HOUR_MS), lte: at } },
      orderBy: { capturedAt: 'asc' },
      take: 200,
      select: { id: true },
    });
    return { count: rows.length, leadIds: rows.map((row) => row.id) };
  },

  async leadsWithExternalKey(externalKey) {
    const rows = await prisma.lead.findMany({
      where: { externalKey },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { id: true, displayId: true, businessName: true, createdAt: true },
    });
    return rows as PhoneTwin[];
  },

  async repeatedFormMessages(since, take) {
    // A form message's provider id is `form:<providerKey>` (LH3/LH6). The
    // unique index refuses the same id twice on a channel, so a replay shows
    // as the same key landing on more than one lead — which is what this
    // groups: one row per (key, lead), folded by the caller.
    const rows = await prisma.leadMessage.groupBy({
      by: ['providerId', 'leadId'],
      where: { direction: 'INBOUND', providerId: { startsWith: 'form:' }, at: { gte: since } },
      _count: { _all: true },
      orderBy: { providerId: 'asc' },
      take,
    });
    return rows
      .filter((row): row is typeof row & { providerId: string } => row.providerId !== null)
      .map((row) => ({ providerId: row.providerId, leadId: row.leadId, count: row._count._all }));
  },

  findFlag(leadId, kind) {
    return prisma.leadFlag.findUnique({ where: { leadId_kind: { leadId, kind: kind as never } } });
  },

  createFlag(data: NewFlag) {
    return prisma.leadFlag.create({ data: { leadId: data.leadId, kind: data.kind as never, detail: data.detail, evidence: (data.evidence ?? null) as never, agentId: data.agentId } });
  },

  updateFlag(id, patch) {
    return prisma.leadFlag.update({
      where: { id },
      data: {
        ...(patch.status ? { status: patch.status as never } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.evidence !== undefined ? { evidence: patch.evidence as never } : {}),
        ...(patch.decidedByUserId !== undefined ? { decidedByUserId: patch.decidedByUserId } : {}),
        ...(patch.decidedAt !== undefined ? { decidedAt: patch.decidedAt } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
      },
    });
  },

  async findFlagById(id) {
    const row = await prisma.leadFlag.findUnique({
      where: { id },
      include: { lead: { select: { displayId: true, businessName: true, city: true, side: true, stage: true, assignedAgentId: true } } },
    });
    return row as FlagWithLead | null;
  },

  async listFlags(filter) {
    const rows = await prisma.leadFlag.findMany({
      where: {
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(filter.kind ? { kind: filter.kind as never } : {}),
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
      },
      include: { lead: { select: { displayId: true, businessName: true, city: true, side: true, stage: true, assignedAgentId: true } } },
      orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
      take: filter.limit,
    });
    return rows as FlagWithLead[];
  },

  async countFlags(filter) {
    const rows = await prisma.leadFlag.groupBy({
      by: ['kind'],
      where: filter.status ? { status: filter.status as never } : {},
      _count: { _all: true },
    });
    return rows.map((row) => ({ kind: row.kind, count: row._count._all }));
  },

  async visitsCompletedBetween(from, to, take) {
    const rows = await prisma.fieldVisit.findMany({
      where: { status: 'COMPLETED', completedAt: { gte: from, lt: to } },
      orderBy: { completedAt: 'asc' },
      take,
      select: {
        id: true, displayId: true, agentId: true, leadId: true, businessName: true, completedAt: true,
        latitude: true, longitude: true, proofFileId: true, proofLatitude: true, proofLongitude: true, proofAt: true,
      },
    });
    return rows as VisitSample[];
  },

  async callsBetween(from, to, take) {
    const rows = await prisma.leadMessage.findMany({
      where: { channel: 'CALL', at: { gte: from, lt: to } },
      orderBy: { at: 'asc' },
      take,
      select: { id: true, leadId: true, byAgentId: true, durationSec: true, consentPlayed: true, recordingFileId: true, outcome: true, at: true },
    });
    return rows as CallSample[];
  },

  async qaSampleExists(kind, id) {
    const found = await prisma.leadQaSample.findFirst({
      where: kind === 'VISIT' ? { visitId: id } : { messageId: id },
      select: { id: true },
    });
    return found !== null;
  },

  createQaSample(data: NewQaSample) {
    return prisma.leadQaSample.create({
      data: {
        kind: data.kind,
        agentId: data.agentId,
        visitId: data.visitId ?? null,
        messageId: data.messageId ?? null,
        leadId: data.leadId ?? null,
        evidence: data.evidence as never,
        autoVerdict: data.autoVerdict,
        sampledAt: data.sampledAt,
      },
    });
  },

  findQaSample(id) {
    return prisma.leadQaSample.findUnique({ where: { id } });
  },

  updateQaSample(id, patch) {
    return prisma.leadQaSample.update({
      where: { id },
      data: {
        ...(patch.verdict ? { verdict: patch.verdict as never } : {}),
        ...(patch.reviewedByUserId ? { reviewedByUserId: patch.reviewedByUserId } : {}),
        ...(patch.reviewedAt ? { reviewedAt: patch.reviewedAt } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
      },
    });
  },

  listQaSamples(filter) {
    return prisma.leadQaSample.findMany({
      where: {
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
        ...(filter.kind ? { kind: filter.kind as never } : {}),
        ...(filter.reviewed === true ? { verdict: { not: null } } : filter.reviewed === false ? { verdict: null } : {}),
      },
      orderBy: { sampledAt: 'desc' },
      take: filter.limit,
    });
  },

  qaSamplesForAgent(agentId, since) {
    return prisma.leadQaSample.findMany({
      where: { agentId, sampledAt: { gte: since } },
      orderBy: { sampledAt: 'desc' },
      take: 500,
      select: { kind: true, autoVerdict: true, verdict: true, sampledAt: true },
    });
  },

  confirmedFlagsForAgent(agentId, since) {
    return prisma.leadFlag.count({ where: { agentId, status: 'CONFIRMED', openedAt: { gte: since } } });
  },

  async activatedSince(since, take) {
    const rows = await prisma.lead.findMany({
      where: { activatedAt: { gte: since } },
      orderBy: { activatedAt: 'asc' },
      take,
      select: { id: true, displayId: true, businessName: true, assignedAgentId: true, activatedAt: true, convertedPublisherId: true, convertedAdvertiserId: true },
    });
    return rows as ClawbackCandidate[];
  },

  async accountStanding(account) {
    if (account.publisherId) {
      const publisher = await prisma.publisher.findUnique({
        where: { id: account.publisherId },
        select: { name: true, user: { select: { closedAt: true, isActive: true } }, listings: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 } },
      });
      if (!publisher) return { live: false, closed: true, label: null };
      return { live: publisher.listings.length > 0, closed: !!publisher.user?.closedAt || publisher.user?.isActive === false, label: publisher.name };
    }
    if (account.advertiserId) {
      const advertiser = await prisma.advertiser.findUnique({
        where: { id: account.advertiserId },
        select: { name: true, companyName: true, user: { select: { closedAt: true, isActive: true } }, campaigns: { where: { status: { in: ['SCHEDULED', 'LIVE', 'PAUSED', 'COMPLETED'] } }, select: { id: true }, take: 1 } },
      });
      if (!advertiser) return { live: false, closed: true, label: null };
      return { live: advertiser.campaigns.length > 0, closed: !!advertiser.user?.closedAt || advertiser.user?.isActive === false, label: advertiser.companyName ?? advertiser.name };
    }
    return { live: false, closed: false, label: null };
  },

  async activationIncentiveFor(account) {
    const row = await prisma.agentIncentive.findFirst({
      where: {
        event: 'LEAD_ACTIVATED',
        status: { in: ['PENDING_VERIFICATION', 'CREDITED'] },
        NOT: { orderId: { startsWith: 'priority:' } },
        ...(account.publisherId ? { publisherId: account.publisherId } : {}),
        ...(account.advertiserId ? { advertiserId: account.advertiserId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, agentId: true, status: true, amount: true },
    });
    return row ? { id: row.id, agentId: row.agentId, status: row.status, amount: row.amount.toFixed(2) } : null;
  },
};
