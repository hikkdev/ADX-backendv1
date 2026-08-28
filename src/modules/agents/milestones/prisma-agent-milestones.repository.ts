import { prisma } from '../../../shared/database';
import type {
  AgentMilestonesRepository,
  NewMilestoneTemplate,
  NewTrainingResource,
} from './agent-milestones.repository';

export const prismaAgentMilestonesRepository: AgentMilestonesRepository = {
  findActiveTemplates() {
    return prisma.milestoneTemplate.findMany({ where: { isActive: true } });
  },

  ensureAgentMilestone(agentId: string, templateId: string) {
    return prisma.agentMilestone.upsert({
      where: { agentId_templateId: { agentId, templateId } },
      update: {},
      create: { agentId, templateId },
    });
  },

  findForAgent(agentId: string) {
    return prisma.agentMilestone.findMany({
      where: { agentId },
      include: { template: true },
      orderBy: { template: { sortOrder: 'asc' } },
    });
  },

  findIncompleteForAgent(agentId: string) {
    return prisma.agentMilestone.findMany({
      where: { agentId, completedAt: null },
      include: { template: true },
    });
  },

  updateProgress(id: string, progress: number, completed: boolean) {
    return prisma.agentMilestone.update({
      where: { id },
      data: { progress, ...(completed ? { completedAt: new Date() } : {}) },
    });
  },

  createTemplate(data: NewMilestoneTemplate) {
    return prisma.milestoneTemplate.create({ data });
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
