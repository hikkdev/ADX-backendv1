import { Prisma, prisma, type VerificationAttempt, type VerificationSession } from '../database';
import type { CheckStatus, CheckType, ErrorClass, VerificationCaseType, VerificationProviderName } from './checks';
import type { SessionStatus, SessionStep } from './composites';
import { newVerificationId, type AttemptRecord, type AttemptStore, type ProviderEventStore, type SessionRecord, type SessionStore, type SessionSubject } from './stores';

/**
 * The verification layer's stores on Postgres — wired by bootstrap
 * (`wireVerification`). The three tables are this layer's own
 * (`VerificationAttempt`, `VerificationSession`, `ProviderEvent`); no
 * module's table is touched from here.
 *
 * The columns are text held to the layer's vocabularies in the code, so a
 * row is read back through a cast — the only writer is the layer itself.
 */

const attemptOf = (row: VerificationAttempt): AttemptRecord => ({
  id: row.id,
  caseType: row.caseType as VerificationCaseType,
  caseId: row.caseId,
  sessionId: row.sessionId,
  checkType: row.checkType as CheckType,
  provider: row.provider as VerificationProviderName,
  attemptNo: row.attemptNo,
  verificationId: row.verificationId,
  status: row.status as CheckStatus,
  errorClass: (row.errorClass as ErrorClass | null) ?? null,
  failureCode: row.failureCode,
  latencyMs: row.latencyMs,
  providerRef: row.providerRef,
  nameMatchScore: row.nameMatchScore === null ? null : Number(row.nameMatchScore),
  result: (row.result as Record<string, unknown> | null) ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const sessionOf = (row: VerificationSession): SessionRecord => ({
  id: row.id,
  caseType: row.caseType as VerificationCaseType,
  caseId: row.caseId,
  workflowKey: row.workflowKey,
  provider: row.provider as VerificationProviderName,
  ownerUserId: row.ownerUserId,
  subject: (row.subject as SessionSubject | null) ?? null,
  steps: (row.steps as unknown as SessionStep[]) ?? [],
  status: row.status as SessionStatus,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const LIVE: SessionStatus[] = ['OPEN', 'NEEDS_USER_ACTION'];

export const prismaAttemptStore: AttemptStore = {
  async open(input) {
    const id = newVerificationId();
    const attemptNo = (await prisma.verificationAttempt.count({ where: { caseType: input.caseType, caseId: input.caseId, checkType: input.checkType } })) + 1;
    const row = await prisma.verificationAttempt.create({
      data: { id, verificationId: id, caseType: input.caseType, caseId: input.caseId, sessionId: input.sessionId ?? null, checkType: input.checkType, provider: input.provider, attemptNo, status: 'PENDING' },
    });
    return attemptOf(row);
  },

  async close(id, outcome) {
    const row = await prisma.verificationAttempt.update({
      where: { id },
      data: {
        status: outcome.status,
        errorClass: outcome.errorClass ?? null,
        failureCode: outcome.failureCode ?? null,
        ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
        ...(outcome.providerRef !== undefined ? { providerRef: outcome.providerRef } : {}),
        ...(outcome.nameMatchScore !== undefined ? { nameMatchScore: outcome.nameMatchScore } : {}),
        ...(outcome.result !== undefined ? { result: outcome.result === null ? Prisma.DbNull : json(outcome.result) } : {}),
      },
    });
    return attemptOf(row);
  },

  async markFailedOver(id, to) {
    const row = await prisma.verificationAttempt.findUnique({ where: { id }, select: { result: true } });
    if (!row) return;
    await prisma.verificationAttempt.update({ where: { id }, data: { result: json({ ...((row.result as Record<string, unknown> | null) ?? {}), failedOverTo: to }) } });
  },

  async find(id) {
    const row = await prisma.verificationAttempt.findUnique({ where: { id } });
    return row ? attemptOf(row) : null;
  },

  async findByProviderRef(provider, checkType, providerRef) {
    const row = await prisma.verificationAttempt.findFirst({ where: { provider, checkType, providerRef }, orderBy: { createdAt: 'desc' } });
    return row ? attemptOf(row) : null;
  },

  async listForCase(caseType, caseId, limit = 200) {
    const rows = await prisma.verificationAttempt.findMany({ where: { caseType, caseId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(attemptOf);
  },

  async listUnfinished(checkTypes, limit) {
    const rows = await prisma.verificationAttempt.findMany({
      where: { status: { in: ['PENDING', 'NEEDS_USER_ACTION'] }, checkType: { in: [...checkTypes] } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(attemptOf);
  },

  async listSince(since, limit) {
    const rows = await prisma.verificationAttempt.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(attemptOf);
  },
};

export const prismaSessionStore: SessionStore = {
  async create(input) {
    const row = await prisma.verificationSession.create({
      data: {
        caseType: input.caseType,
        caseId: input.caseId,
        workflowKey: input.workflowKey,
        provider: input.provider,
        ownerUserId: input.ownerUserId,
        subject: input.subject ? json(input.subject) : Prisma.DbNull,
        steps: json(input.steps),
        status: input.status,
        expiresAt: input.expiresAt,
      },
    });
    return sessionOf(row);
  },

  async find(id) {
    const row = await prisma.verificationSession.findUnique({ where: { id } });
    return row ? sessionOf(row) : null;
  },

  async update(id, patch) {
    const row = await prisma.verificationSession.update({
      where: { id },
      data: {
        ...(patch.steps !== undefined ? { steps: json(patch.steps) } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject ? json(patch.subject) : Prisma.DbNull } : {}),
        ...(patch.ownerUserId !== undefined ? { ownerUserId: patch.ownerUserId } : {}),
      },
    });
    return sessionOf(row);
  },

  async findOpenForCase(caseType, caseId) {
    const row = await prisma.verificationSession.findFirst({ where: { caseType, caseId, status: { in: LIVE } }, orderBy: { createdAt: 'desc' } });
    return row ? sessionOf(row) : null;
  },

  async listForCase(caseType, caseId) {
    const rows = await prisma.verificationSession.findMany({ where: { caseType, caseId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(sessionOf);
  },

  async listOpenForOwner(ownerUserId) {
    const rows = await prisma.verificationSession.findMany({ where: { ownerUserId, status: { in: LIVE } }, orderBy: { createdAt: 'desc' }, take: 10 });
    return rows.map(sessionOf);
  },

  async listOverdue(now, limit) {
    const rows = await prisma.verificationSession.findMany({ where: { status: { in: LIVE }, expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' }, take: limit });
    return rows.map(sessionOf);
  },
};

export const prismaProviderEventStore: ProviderEventStore = {
  async claim(provider, eventId, eventType) {
    try {
      const row = await prisma.providerEvent.create({ data: { provider, eventId, eventType } });
      return { fresh: true, id: row.id };
    } catch (err) {
      // The unique index on (provider, eventId) is the de-duplication: a second insert is the same event again.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { fresh: false, id: null };
      throw err;
    }
  },

  async finish(id, outcome) {
    await prisma.providerEvent.update({ where: { id }, data: { processedAt: new Date(), outcome: outcome.slice(0, 200) } });
  },
};
