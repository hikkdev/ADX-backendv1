import { prisma } from '../lib/prisma';
import type { MilestoneType } from '../generated/prisma';

export async function getMilestonesForAgent(agentId: string) {
  const agent = await prisma.agentProfile.findUnique({ where: { id: agentId } });

  // Auto-create AgentMilestone rows for any active templates that don't exist yet
  const templates = await prisma.milestoneTemplate.findMany({ where: { isActive: true } });

  await Promise.all(
    templates.map((template) =>
      prisma.agentMilestone.upsert({
        where: { agentId_templateId: { agentId, templateId: template.id } },
        update: {},
        create: { agentId, templateId: template.id },
      }),
    ),
  );

  return prisma.agentMilestone.findMany({
    where: { agentId },
    include: { template: true },
    orderBy: { template: { sortOrder: 'asc' } },
  });
}

export async function incrementMilestoneProgress(agentId: string, type: MilestoneType) {
  const milestones = await prisma.agentMilestone.findMany({
    where: { agentId, completedAt: null },
    include: { template: true },
  });

  const relevant = milestones.filter((m) => m.template.type === type);

  for (const m of relevant) {
    const newProgress = m.progress + 1;
    await prisma.agentMilestone.update({
      where: { id: m.id },
      data: {
        progress: newProgress,
        ...(newProgress >= m.template.target ? { completedAt: new Date() } : {}),
      },
    });
  }
}

export async function createMilestoneTemplate(data: {
  type: MilestoneType;
  title: string;
  description: string;
  target: number;
  rewardAmount?: number;
}) {
  return prisma.milestoneTemplate.create({ data });
}

export async function getTrainingResources(opts: { category?: string; search?: string } = {}) {
  const { category, search } = opts;
  return prisma.trainingResource.findMany({
    where: {
      isActive: true,
      ...(category && category !== 'All' ? { category } : {}),
      ...(search
        ? { OR: [{ title: { contains: search, mode: 'insensitive' } }, { subtitle: { contains: search, mode: 'insensitive' } }] }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createTrainingResource(data: {
  title: string;
  category: string;
  duration?: string;
  subtitle?: string;
  topic?: string;
  status?: string;
  statusVariant?: string;
  videoUrl?: string;
  documentUrl?: string;
}) {
  return prisma.trainingResource.create({ data });
}
