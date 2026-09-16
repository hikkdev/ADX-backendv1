import { prisma } from '../../shared/database';
import type { ModulePatch, NewModule, NewQuestion, NewTrainingResource, TrainingRepository } from './training.repository';

/** The agent beside a certification — what the desk's list draws, and (T-B) what the revoke answers. */
const certificationAgentInclude = { agent: { select: { id: true, displayId: true, user: { select: { name: true } } } } } as const;

export const prismaTrainingRepository: TrainingRepository = {
  findActiveModules() {
    return prisma.trainingModule.findMany({ where: { isActive: true }, orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }] });
  },

  findModules() {
    return prisma.trainingModule.findMany({
      orderBy: [{ ordinal: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { questions: true } } },
    });
  },

  findModule(id) {
    return prisma.trainingModule.findUnique({ where: { id } });
  },

  createModule(data: NewModule) {
    return prisma.trainingModule.create({ data });
  },

  updateModule(id, patch: ModulePatch) {
    return prisma.trainingModule.update({ where: { id }, data: patch });
  },

  findQuestions(moduleId) {
    return prisma.trainingQuestion.findMany({
      where: { moduleId, isActive: true },
      orderBy: { ordinal: 'asc' },
      include: { options: { orderBy: { ordinal: 'asc' } } },
    });
  },

  async replaceQuestions(moduleId, questions) {
    // Old attempts keep their answers as JSON, so the old rows can go.
    await prisma.$transaction(async (tx) => {
      await tx.trainingQuestion.deleteMany({ where: { moduleId } });
      for (const [i, question] of questions.entries()) {
        await tx.trainingQuestion.create({
          data: {
            moduleId,
            ordinal: i + 1,
            prompt: question.prompt,
            options: {
              create: question.options.map((option, j) => ({ ordinal: j + 1, label: option.label, isCorrect: option.isCorrect })),
            },
          },
        });
      }
    });
    return this.findQuestions(moduleId);
  },

  findProgress(agentId) {
    return prisma.agentTrainingProgress.findMany({ where: { agentId } });
  },

  upsertProgress(agentId, moduleId, data) {
    return prisma.agentTrainingProgress.upsert({
      where: { agentId_moduleId: { agentId, moduleId } },
      update: data,
      create: { agentId, moduleId, ...data },
    });
  },

  createAttempt(data) {
    return prisma.trainingAttempt.create({ data });
  },

  async bestAttempts(agentId) {
    const attempts = await prisma.trainingAttempt.findMany({
      where: { agentId },
      orderBy: [{ score: 'desc' }, { submittedAt: 'asc' }],
    });
    const best = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      if (!best.has(attempt.moduleId)) best.set(attempt.moduleId, attempt);
    }
    return [...best.values()];
  },

  findCertification(agentId) {
    return prisma.agentCertification.findUnique({ where: { agentId } });
  },

  createCertification(agentId, certificateId, issuedAt) {
    return prisma.agentCertification.create({ data: { agentId, certificateId, issuedAt } });
  },

  // T-B: the revoke answers the row the desk lists — the same include on the write.
  revokeCertification(id, data) {
    return prisma.agentCertification.update({ where: { id }, data, include: certificationAgentInclude });
  },

  listCertifications() {
    return prisma.agentCertification.findMany({ orderBy: { issuedAt: 'desc' }, include: certificationAgentInclude });
  },

  async agentName(agentId) {
    const row = await prisma.agentProfile.findUnique({ where: { id: agentId }, select: { user: { select: { name: true } } } });
    return row?.user.name ?? null;
  },

  findTrainingResources({ category, search }) {
    return prisma.trainingResource.findMany({
      where: {
        isActive: true,
        // 'All' is the UI's no-filter sentinel, not a real category.
        ...(category && category !== 'All' ? { category } : {}),
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: 'insensitive' } },
                { subtitle: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  createTrainingResource(data: NewTrainingResource) {
    return prisma.trainingResource.create({ data });
  },
};
