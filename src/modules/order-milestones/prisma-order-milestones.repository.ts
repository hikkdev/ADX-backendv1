import { prisma } from '../../shared/database';
import type { OrderMilestoneStatus, OrderMilestoneType } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import type {
  NewOrderMilestone,
  NewReinstallMilestone,
  NewTemplate,
  OrderMilestonePatch,
  OrderMilestonesRepository,
  PlanItemInput,
  TemplatePatch,
} from './order-milestones.repository';
import type { EvidenceInput } from './order-milestones.types';

const planInclude = { items: { include: { template: true }, orderBy: { order: 'asc' } } } as const;
/*
 * 2 Oct 2026: the publisher on an agent's milestone is the business the agent
 * visits — the name, the number and the address. It used to be the whole
 * Publisher row (GSTIN, email, KYC and suspension facts) in the agent's answer.
 */
const visitPublisherSelect = {
  id: true,
  userId: true,
  displayId: true,
  name: true,
  mobile: true,
  address: true,
  city: true,
  state: true,
} as const;

/** The agent holding a milestone, as the console's order page names them — never the whole User row. */
const assignedAgentSelect = {
  id: true,
  userId: true,
  displayId: true,
  user: { select: { id: true, name: true, firstName: true, lastName: true, displayId: true, avatarUrl: true, mobile: true } },
} as const;

const agentWorkInclude = {
  template: true,
  orderRecord: { include: { listing: { include: { publisher: { select: visitPublisherSelect } } } } },
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
      include: { template: true, assignedAgent: { select: assignedAgentSelect }, evidence: true },
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
    // Issued to the agent already holding the order: theirs from the start,
    // so accepted on creation rather than offered (A12).
    const acceptedAt = new Date();
    return prisma.orderMilestone.createMany({
      data: rows.map((row) => ({ ...row, status: 'DISPATCHED' as OrderMilestoneStatus, acceptedAt })),
    });
  },

  findWithOrderStatus(milestoneId: string) {
    return prisma.orderMilestone.findUnique({
      where: { id: milestoneId },
      include: {
        template: true,
        orderRecord: { select: { status: true, agentId: true, startDate: true, endDate: true } },
      },
    }) as never;
  },

  async findSiteCode(orderId: string) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { listingId: true, listing: { select: { qrToken: true } } },
    });
    return order ? { listingId: order.listingId, qrToken: order.listing.qrToken } : null;
  },

  updateMilestone(milestoneId: string, patch: OrderMilestonePatch) {
    return prisma.orderMilestone.update({
      where: { id: milestoneId },
      data: patch,
      include: { template: true, assignedAgent: { select: assignedAgentSelect } },
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

  // ── Lot D (Q54/Q92): the re-install ──────────────────────────────────

  findActiveTemplateByType(type: OrderMilestoneType) {
    return prisma.orderMilestoneTemplate.findFirst({ where: { type, isActive: true }, orderBy: { createdAt: 'asc' } });
  },

  createReinstall(data: NewReinstallMilestone) {
    return prisma.orderMilestone.create({
      data: {
        ...data,
        status: data.assignedAgentId ? 'DISPATCHED' : 'PENDING',
        isOptional: false,
      },
    });
  },

  findStatuses(milestoneIds: string[]) {
    if (milestoneIds.length === 0) return Promise.resolve([]);
    return prisma.orderMilestone.findMany({
      where: { id: { in: milestoneIds } },
      select: { id: true, status: true },
    });
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

  // ── A12: the offer ─────────────────────────────────────────────────────

  accept(milestoneId: string, at: Date) {
    return prisma.orderMilestone.update({
      where: { id: milestoneId },
      data: { acceptedAt: at, rejectionReason: null },
      include: agentWorkInclude,
    });
  },

  reject(milestoneId: string, reason: string) {
    return prisma.orderMilestone.update({
      where: { id: milestoneId },
      data: {
        status: 'PENDING',
        assignedAgentId: null,
        offeredAt: null,
        offerExpiresAt: null,
        acceptedAt: null,
        scheduledStart: null,
        scheduledEnd: null,
        rejectionReason: reason,
      },
      include: { template: true },
    });
  },

  schedule(milestoneId: string, start: Date, end: Date) {
    return prisma.orderMilestone.update({
      where: { id: milestoneId },
      data: { scheduledStart: start, scheduledEnd: end, dueDate: start },
      include: agentWorkInclude,
    });
  },

  findDispatchedForAgent(agentId: string) {
    return prisma.orderMilestone.findMany({
      where: { assignedAgentId: agentId, status: 'DISPATCHED' },
      select: { id: true, orderId: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  // ST-2: the agent sent to a listing — a visit of theirs on one of its
  // orders (open, or completed since `since`), or the order's own agent.
  async agentHasWorkOnListing(agentId: string, listingId: string, since: Date) {
    const [visit, order] = await Promise.all([
      prisma.orderMilestone.findFirst({
        where: {
          assignedAgentId: agentId,
          orderRecord: { listingId },
          OR: [{ status: { in: ['DISPATCHED', 'IN_PROGRESS'] } }, { status: 'COMPLETED', completedAt: { gte: since } }],
        },
        select: { id: true },
      }),
      prisma.order.findFirst({
        where: {
          agentId,
          listingId,
          status: { notIn: ['DRAFT', 'CANCELLED', 'PUBLISHER_REJECTED', 'AGENT_REJECTED'] },
          OR: [{ status: { not: 'COMPLETED' } }, { updatedAt: { gte: since } }],
        },
        select: { id: true },
      }),
    ]);
    return Boolean(visit || order);
  },

  findOfferExpired(windowStart: Date, now: Date) {
    return prisma.orderMilestone.findMany({
      where: {
        status: 'DISPATCHED',
        acceptedAt: null,
        offerExpiresAt: { gt: windowStart, lte: now },
      },
      select: { id: true, orderId: true, assignedAgentId: true },
    });
  },

  async findScheduledStartsForOrder(orderId: string, exceptMilestoneId: string) {
    const rows = await prisma.orderMilestone.findMany({
      where: { orderId, id: { not: exceptMilestoneId }, scheduledStart: { not: null } },
      select: { scheduledStart: true },
    });
    return rows.flatMap((row) => (row.scheduledStart ? [row.scheduledStart] : []));
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
