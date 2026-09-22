import { prisma, Prisma } from '../../../shared/database';
import type { AgentDocumentKind, AgentDocumentStatus } from '../../../shared/database';
import type { ApplicationRecord, ApplicationRepository, ApplicationRow, ApplicationsFilter, DocumentStamp, NewApplication, NewDocument, NewInterview, ProfilePatch, SideRows } from './application.repository';

const includeRecord = {
  user: { select: { id: true, name: true, mobile: true, email: true, dateOfBirth: true, gender: true, isActive: true, roles: { select: { role: true } } } },
  documents: { orderBy: { kind: 'asc' as const } },
  educations: { orderBy: { createdAt: 'asc' as const } },
  employments: { orderBy: { createdAt: 'asc' as const } },
  references: { orderBy: { createdAt: 'asc' as const } },
  platformExperiences: { orderBy: { createdAt: 'asc' as const } },
  interviews: { orderBy: [{ round: 'asc' as const }, { scheduledAt: 'asc' as const }] },
  kyc: { select: { status: true, reviewedAt: true } },
} satisfies Prisma.AgentProfileInclude;

type Loaded = Prisma.AgentProfileGetPayload<{ include: typeof includeRecord }>;

function shape(row: Loaded): ApplicationRecord {
  const { user, ...profile } = row;
  const { roles, ...person } = user;
  return { ...profile, user: person, roles: roles.map((r) => r.role), kyc: row.kyc };
}

const sideWhere = (side: ApplicationsFilter['side']): Prisma.AgentProfileWhereInput =>
  side ? { user: { roles: { some: { role: side === 'PUBLISHER' ? 'AGENT_PUBLISHER' : 'AGENT_ADVERTISER' } } } } : {};

const whereOf = (filter: ApplicationsFilter): Prisma.AgentProfileWhereInput => ({
  ...(filter.stage ? { stage: filter.stage } : filter.stages ? { stage: { in: [...filter.stages] } } : {}),
  ...sideWhere(filter.side),
  ...(filter.q
    ? { OR: [{ displayId: { contains: filter.q, mode: 'insensitive' } }, { user: { OR: [{ name: { contains: filter.q, mode: 'insensitive' } }, { mobile: { contains: filter.q } }] } }] }
    : {}),
});

export const prismaApplicationRepository: ApplicationRepository = {
  async createApplication(userId, input: NewApplication) {
    const row = await prisma.$transaction(async (tx) => {
      const held = await tx.userRole.findFirst({ where: { userId, role: input.role }, select: { id: true } });
      if (!held) await tx.userRole.create({ data: { userId, role: input.role } });
      return tx.agentProfile.create({
        data: {
          userId,
          displayId: input.displayId,
          stage: 'PROFILE',
          sourceKind: input.sourceKind,
          sourceNote: input.sourceNote,
          referredByAgentId: input.referredByAgentId,
          fleetPartnerId: input.fleetPartnerId ?? null,
        },
        include: includeRecord,
      });
    });
    return shape(row);
  },

  async findByUserId(userId) {
    const row = await prisma.agentProfile.findUnique({ where: { userId }, include: includeRecord });
    return row ? shape(row) : null;
  },

  async findById(agentId) {
    const row = await prisma.agentProfile.findUnique({ where: { id: agentId }, include: includeRecord });
    return row ? shape(row) : null;
  },

  async patch(agentId, patch: ProfilePatch) {
    await prisma.agentProfile.update({ where: { id: agentId }, data: patch });
  },

  async patchPerson(userId, patch) {
    if (Object.keys(patch).length === 0) return;
    await prisma.user.update({ where: { id: userId }, data: patch as Prisma.UserUpdateInput });
  },

  async replaceSideRows(agentId, rows: SideRows) {
    await prisma.$transaction(async (tx) => {
      if (rows.educations) {
        await tx.agentEducation.deleteMany({ where: { agentId } });
        if (rows.educations.length) await tx.agentEducation.createMany({ data: rows.educations.map((r) => ({ agentId, level: r.level, degree: r.degree ?? null, institution: r.institution ?? null, year: r.year ?? null })) });
      }
      if (rows.employments) {
        await tx.agentEmployment.deleteMany({ where: { agentId } });
        if (rows.employments.length) {
          await tx.agentEmployment.createMany({
            data: rows.employments.map((r) => ({ agentId, employer: r.employer, role: r.role ?? null, industry: r.industry ?? null, fromMonth: r.fromMonth ?? null, toMonth: r.toMonth ?? null, current: r.current ?? false, reasonForLeaving: r.reasonForLeaving ?? null })),
          });
        }
      }
      if (rows.references) {
        await tx.agentReference.deleteMany({ where: { agentId } });
        if (rows.references.length) await tx.agentReference.createMany({ data: rows.references.map((r) => ({ agentId, name: r.name, relation: r.relation ?? null, phone: r.phone })) });
      }
      if (rows.platformExperiences) {
        await tx.agentPlatformExperience.deleteMany({ where: { agentId } });
        if (rows.platformExperiences.length) {
          await tx.agentPlatformExperience.createMany({
            data: rows.platformExperiences.map((r) => ({ agentId, platform: r.platform, partnerId: r.partnerId ?? null, years: r.years ?? null, active: r.active ?? true, ratingNote: r.ratingNote ?? null })),
          });
        }
      }
    });
  },

  upsertDocument(doc: NewDocument) {
    const fresh = { url: doc.url, numberMasked: doc.numberMasked, numberHash: doc.numberHash, expiresAt: doc.expiresAt, uploadedVia: doc.uploadedVia, uploadedById: doc.uploadedById };
    return prisma.agentDocument.upsert({
      where: { agentId_kind: { agentId: doc.agentId, kind: doc.kind } },
      create: { agentId: doc.agentId, kind: doc.kind, ...fresh },
      // A new upload restarts the review: SUBMITTED, the old note cleared, the version up;
      // AG-4: its expiry clock and any verification start over too.
      update: { ...fresh, status: 'SUBMITTED', reviewNote: null, reviewedById: null, reviewedAt: null, version: { increment: 1 }, expiredAt: null, expiryRemindedAt: null, expiryReminderDays: null, verifiedVia: null, verifiedAt: null, verificationPayload: Prisma.DbNull },
    });
  },

  async removeDocument(agentId, kind) {
    await prisma.agentDocument.deleteMany({ where: { agentId, kind } });
  },

  async reviewDocument(agentId, kind: AgentDocumentKind, status: AgentDocumentStatus, note, reviewedById) {
    const existing = await prisma.agentDocument.findUnique({ where: { agentId_kind: { agentId, kind } }, select: { id: true } });
    if (!existing) return null;
    return prisma.agentDocument.update({ where: { id: existing.id }, data: { status, reviewNote: note, reviewedById, reviewedAt: new Date() } });
  },

  async numberHeldElsewhere(agentId, numberHash) {
    const other = await prisma.agentDocument.findFirst({ where: { numberHash, agentId: { not: agentId } }, select: { id: true } });
    return other !== null;
  },

  findAgentByReferralCode(code) {
    return prisma.agentProfile.findUnique({ where: { referralCode: code }, select: { id: true } });
  },

  async findApplications(filter, page, pageSize) {
    const where = whereOf(filter);
    const [rows, total] = await Promise.all([
      prisma.agentProfile.findMany({
        where,
        orderBy: [{ applicationSubmittedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          displayId: true,
          stage: true,
          grade: true,
          sourceKind: true,
          city: true,
          createdAt: true,
          applicationSubmittedAt: true,
          activatedAt: true,
          user: { select: { name: true, mobile: true, email: true, roles: { select: { role: true } } } },
          documents: { select: { kind: true, status: true } },
        },
      }),
      prisma.agentProfile.count({ where }),
    ]);
    const items: ApplicationRow[] = rows.map((r) => ({
      id: r.id,
      displayId: r.displayId,
      stage: r.stage,
      grade: r.grade,
      sourceKind: r.sourceKind,
      city: r.city,
      createdAt: r.createdAt,
      applicationSubmittedAt: r.applicationSubmittedAt,
      activatedAt: r.activatedAt,
      roles: r.user.roles.map((x) => x.role),
      user: { name: r.user.name, mobile: r.user.mobile, email: r.user.email },
      documents: r.documents,
    }));
    return { items, total };
  },

  async countByStage(filter) {
    const rows = await prisma.agentProfile.groupBy({ by: ['stage'], where: whereOf(filter), _count: { _all: true } });
    return rows.map((r) => ({ stage: r.stage, count: r._count._all }));
  },

  async employeeExists(employeeId) {
    return (await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } })) !== null;
  },

  /* ── AG-4 ── */

  createInterview(input: NewInterview) {
    return prisma.agentInterview.create({ data: input });
  },

  findInterview(agentId, interviewId) {
    return prisma.agentInterview.findFirst({ where: { id: interviewId, agentId } });
  },

  updateInterview(interviewId, patch) {
    return prisma.agentInterview.update({ where: { id: interviewId }, data: patch });
  },

  documentsExpiring(before) {
    return prisma.agentDocument.findMany({
      where: {
        expiresAt: { lte: before },
        expiredAt: null,
        status: { in: ['SUBMITTED', 'APPROVED'] },
        agent: { stage: { notIn: ['REJECTED', 'WITHDRAWN', 'EXITED'] } },
      },
      select: {
        id: true,
        agentId: true,
        kind: true,
        status: true,
        expiresAt: true,
        expiryRemindedAt: true,
        expiryReminderDays: true,
        agent: { select: { id: true, userId: true, stage: true, displayId: true, user: { select: { name: true } } } },
      },
      orderBy: { expiresAt: 'asc' },
    }) as Promise<import('./application.repository').ExpiringDocument[]>;
  },

  async stampDocument(documentId, stamp: DocumentStamp) {
    await prisma.agentDocument.update({ where: { id: documentId }, data: stamp });
  },

  findDocument(agentId, kind: AgentDocumentKind) {
    return prisma.agentDocument.findUnique({ where: { agentId_kind: { agentId, kind } } });
  },

  /* ── AG-5 ── */

  agentsForPurge(before) {
    return prisma.agentProfile.findMany({
      where: { stage: 'EXITED', exitedAt: { lte: before }, documentsPurgedAt: null, documents: { some: {} } },
      select: { id: true, exitedAt: true, exitedById: true, documents: { select: { id: true, url: true } } },
      take: 100,
    });
  },

  async purgeDocuments(agentId, at) {
    await prisma.$transaction([
      prisma.agentDocument.deleteMany({ where: { agentId } }),
      prisma.agentProfile.update({ where: { id: agentId }, data: { documentsPurgedAt: at } }),
    ]);
  },
};
