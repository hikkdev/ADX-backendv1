import { Prisma, prisma } from '../../shared/database';
import type { FraudCaseStatus, SuspendedPartyType } from '../../shared/database';
import { countsFrom, listArgs, toListPage } from '../../shared/pagination';
import type { FraudCasePatch, FraudRepository, NewFraudCase } from './fraud.repository';
import { FRAUD_CASE_STATUSES, OPEN_CASE_STATUSES, type ListCasesQuery } from './fraud.schema';

/** The signals column is JSON; null clears it. */
const jsonPatch = (patch: FraudCasePatch): Prisma.FraudCaseUpdateInput => {
  const { signals, ...rest } = patch;
  return {
    ...rest,
    ...(signals === undefined ? {} : { signals: signals === null ? Prisma.DbNull : (signals as unknown as Prisma.InputJsonValue) }),
  };
};

export const prismaFraudRepository: FraudRepository = {
  async list(query: ListCasesQuery) {
    // Everything but the status facet, so the chip row still counts.
    const base: Prisma.FraudCaseWhereInput = {
      ...(query.subjectType ? { subjectType: query.subjectType as SuspendedPartyType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.disputeId ? { disputeId: query.disputeId } : {}),
      ...(query.q
        ? {
            OR: [
              { displayId: { contains: query.q, mode: 'insensitive' } },
              { subjectId: { contains: query.q, mode: 'insensitive' } },
              { kind: { contains: query.q, mode: 'insensitive' } },
              { summary: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const where: Prisma.FraudCaseWhereInput = {
      ...base,
      ...(query.status?.length ? { status: { in: query.status as FraudCaseStatus[] } } : {}),
    };
    const [items, total, groups] = await Promise.all([
      prisma.fraudCase.findMany({
        where,
        orderBy: { createdAt: query.sort === 'OLDEST' ? 'asc' : 'desc' },
        ...listArgs(query),
      }),
      prisma.fraudCase.count({ where }),
      prisma.fraudCase.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return toListPage(items, total, countsFrom(groups, FRAUD_CASE_STATUSES), query);
  },

  findById(caseId: string) {
    return prisma.fraudCase.findUnique({
      where: { id: caseId },
      include: {
        notes: { orderBy: { createdAt: 'asc' } },
        evidence: { orderBy: { createdAt: 'asc' } },
      },
    });
  },

  findSummaryById(caseId: string) {
    return prisma.fraudCase.findUnique({ where: { id: caseId } });
  },

  // E6: the number arrives minted — `identifiers` issues FRD-… through its
  // own counter, so this is a plain insert with no per-year count to race.
  create(data: NewFraudCase, now: Date) {
    const { signals, ...rest } = data;
    return prisma.fraudCase.create({
      data: {
        ...rest,
        createdAt: now,
        ...(signals === undefined ? {} : { signals: signals === null ? Prisma.DbNull : (signals as unknown as Prisma.InputJsonValue) }),
      },
    });
  },

  update(caseId: string, patch: FraudCasePatch) {
    return prisma.fraudCase.update({ where: { id: caseId }, data: jsonPatch(patch) });
  },

  async addNote(data) {
    const [note] = await prisma.$transaction([
      prisma.fraudCaseNote.create({ data }),
      prisma.fraudCase.update({ where: { id: data.caseId }, data: { updatedAt: new Date() } }),
    ]);
    return note;
  },

  async addEvidence(data) {
    const [evidence] = await prisma.$transaction([
      prisma.fraudCaseEvidence.create({ data }),
      prisma.fraudCase.update({ where: { id: data.caseId }, data: { updatedAt: new Date() } }),
    ]);
    return evidence;
  },

  findOpenForDisputes(disputeIds: string[]) {
    if (disputeIds.length === 0) return Promise.resolve([]);
    return prisma.fraudCase.findMany({
      where: { disputeId: { in: disputeIds }, status: { in: [...OPEN_CASE_STATUSES] } },
      select: { id: true, displayId: true, status: true, disputeId: true },
      orderBy: { createdAt: 'desc' },
    });
  },

  findOpenForSubject(subjectType: SuspendedPartyType, subjectId: string) {
    return prisma.fraudCase.findFirst({
      where: { subjectType, subjectId, status: { in: [...OPEN_CASE_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
  },
};
