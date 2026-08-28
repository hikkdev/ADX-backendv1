import { prisma } from '../../shared/database';
import type { OrderMilestoneStatus } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import type {
  NewOrderMilestone,
  NewTemplate,
  OrderMilestonePatch,
  OrderMilestonesRepository,
  PlanItemInput,
  TemplatePatch,
} from './order-milestones.repository';
import type { EvidenceInput } from './order-milestones.types';

const planInclude = { items: { include: { template: true }, orderBy: { order: 'asc' } } } as const;
const agentWorkInclude = {
  template: true,
  orderRecord: { include: { listing: { include: { publisher: true } } } },
  evidence: true,
} as const;

export const prismaOrderMilestonesRepository: OrderMilestonesRepository = {
  createTemplate(data: NewTemplate) {
    return prisma.orderMilestoneTemplate.create({
      data: { ...data, requirements: data.requirements as object[] },
    });
  },

  listTemplates(isActive?: boolean) {
    return prisma.orderMilestoneTemplate.findMany({
      where: isActive !== undefined ? { isActive } : {},
      orderBy: { createdAt: 'asc' },
    });
  },

  findTemplate(id: string) {
    return prisma.orderMilestoneTemplate.findUnique({ where: { id } });
  },

  findTemplatesByIds(ids: string[]) {
    return prisma.orderMilestoneTemplate.findMany({ where: { id: { in: ids } } });
  },

  updateTemplate(id: string, patch: TemplatePatch) {
    const { requirements, ...rest } = patch;
    return prisma.orderMilestoneTemplate.update({
      where: { id },
      data: { ...rest, ...(requirements ? { requirements: requirements as object[] } : {}) },
    });
  },

  createPlan(data: { name: string; description?: string }) {
    return prisma.milestonePlan.create({ data });
  },

  listPlans() {
    return prisma.milestonePlan.findMany({ include: planInclude, orderBy: { createdAt: 'asc' } });
  },

  findPlan(id: string) {
    return prisma.milestonePlan.findUnique({ where: { id }, include: planInclude });
  },

  findPlanWithItems(id: string) {
    return prisma.milestonePlan.findUnique({
      where: { id },
      include: { items: { orderBy: { order: 'asc' } } },
    }) as never;
  },

  updatePlan(id: string, patch: { name?: string; description?: string; isActive?: boolean }) {
    return prisma.milestonePlan.update({ where: { id }, data: patch });
  },

  replacePlanItems(planId: string, items: PlanItemInput[]) {
    // One transaction so a plan is never left with no items.
    return prisma.$transaction(async (tx) => {
      await tx.milestonePlanItem.deleteMany({ where: { planId } });
      return tx.milestonePlanItem.createMany({
        data: items.map((i) => ({
          planId,
          templateId: i.templateId,
          order: i.order,
          isOptional: i.isOptional ?? false,
        })),
      });
    });
  },

  findForOrder(orderId: string) {
    return prisma.orderMilestone.findMany({
      where: { orderId },
      include: { template: true, assignedAgent: { include: { user: true } }, evidence: true },
      orderBy: { order: 'asc' },
    });
  },

  countForOrder(orderId: string) {
    return prisma.orderMilestone.count({ where: { orderId } });
  },

  async findLastOrderIndex(orderId: string) {
    const last = await prisma.orderMilestone.findFirst({
      where: { orderId },
      orderBy: { order: 'desc' },
    });
    return last?.order ?? null;
  },

  createForOrder(data: NewOrderMilestone) {
    return prisma.orderMilestone.create({
      data: { ...data, status: 'PENDING' },
      include: { template: true },
    });
  },

  createManyForOrder(rows) {
    return prisma.orderMilestone.createMany({
      data: rows.map((row) => ({ ...row, status: 'DISPATCHED' as OrderMilestoneStatus })),
    });
  },

  findWithOrderStatus(milestoneId: string) {
    return prisma.orderMilestone.findUnique({
      where: { id: milestoneId },
      include: { template: true, orderRecord: { select: { status: true } } },
    }) as never;
  },

  updateMilestone(milestoneId: string, patch: OrderMilestonePatch) {
    return prisma.orderMilestone.update({
      where: { id: milestoneId },
      data: patch,
      include: { template: true, assignedAgent: { include: { user: true } } },
    });
  },

  async deleteIfRemovable(milestoneId: string) {
    // Conditional delete rather than check-then-delete: the status could change
    // between the two.
    const result = await prisma.orderMilestone.deleteMany({
      where: { id: milestoneId, status: { in: ['PENDING', 'DISPATCHED'] } },
    });
    return result.count;
  },

  findForAgent(agentId: string) {
    return prisma.orderMilestone.findMany({
      where: { assignedAgentId: agentId, status: { in: ['DISPATCHED', 'IN_PROGRESS'] } },
      include: agentWorkInclude,
      orderBy: [{ dueDate: 'asc' }, { order: 'asc' }],
    });
  },

  findDetail(milestoneId: string) {
    return prisma.orderMilestone.findUnique({
      where: { id: milestoneId },
      include: agentWorkInclude,
    }) as never;
  },

  start(milestoneId: string) {
    return prisma.orderMilestone.update({
      where: { id: milestoneId },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
      include: { template: true },
    });
  },

  complete(milestoneId: string, evidence: EvidenceInput[]) {
    return prisma.$transaction(async (tx) => {
      // Conditional flip: only succeeds if still IN_PROGRESS, which is what
      // prevents two concurrent requests both completing the milestone.
      const updated = await tx.orderMilestone.updateMany({
        where: { id: milestoneId, status: 'IN_PROGRESS' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      if (updated.count === 0) {
        throw new ApiError(409, 'CONFLICT', 'Milestone was already completed by a concurrent request');
      }

      await tx.orderMilestoneEvidence.createMany({
        data: evidence.map((e) => ({
          milestoneId,
          kind: e.kind,
          label: e.label,
          value: e.value,
        })),
      });

      return tx.orderMilestone.findUniqueOrThrow({
        where: { id: milestoneId },
        include: { template: true, evidence: true },
      });
    });
  },
};
