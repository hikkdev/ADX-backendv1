import { prisma } from '../../../shared/database';
import { Decimal } from '../../../shared/money';
import { arrivedOnTime } from '../rating/rating.rules';
import type {
  AgentMilestonesRepository,
  MilestoneTemplatePatch,
  NewMilestoneTemplate,
  Window,
} from './agent-milestones.repository';

/** `gte from, lt to` on a date column, with either end open. */
const inside = (window: Window) =>
  window.from || window.to
    ? { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lt: window.to } : {}) }
    : undefined;

export const prismaAgentMilestonesRepository: AgentMilestonesRepository = {
  findActiveTemplates() {
    return prisma.milestoneTemplate.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  },

  findTemplates() {
    return prisma.milestoneTemplate.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  },

  findTemplate(id: string) {
    return prisma.milestoneTemplate.findUnique({ where: { id } });
  },

  createTemplate(data: NewMilestoneTemplate) {
    return prisma.milestoneTemplate.create({ data });
  },

  updateTemplate(id: string, patch: MilestoneTemplatePatch) {
    return prisma.milestoneTemplate.update({ where: { id }, data: patch });
  },

  findAgent(agentId: string) {
    return prisma.agentProfile.findUnique({ where: { id: agentId }, select: { id: true, userId: true, tier: true } });
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

  findById(id: string) {
    return prisma.agentMilestone.findUnique({ where: { id }, include: { template: true } });
  },

  writeDerived(id, data) {
    return prisma.agentMilestone.update({ where: { id }, data });
  },

  claim(id, data) {
    return prisma.agentMilestone.update({ where: { id }, data, include: { template: true } });
  },

  async countOnboarded(agentId, window) {
    // The same two counters the tier ladder climbs on: a publisher when the
    // ladder says so, an advertiser when activated. Windowed on the activation
    // instant, because that is the moment the account became usable.
    const activated = inside(window);
    const [publishers, advertisers] = await Promise.all([
      prisma.publisher.count({
        where: { agentId, onboardingStatus: 'ONBOARDING_COMPLETE', ...(activated ? { activatedAt: activated } : {}) },
      }),
      prisma.advertiser.count({
        where: { agentId, activatedAt: activated ?? { not: null } },
      }),
    ]);
    return publishers + advertisers;
  },

  async countActivity(agentId, userId, window) {
    const at = inside(window);
    const [visits, verifications] = await Promise.all([
      prisma.fieldVisit.count({
        where: { agentId, status: 'COMPLETED', ...(at ? { completedAt: at } : {}) },
      }),
      prisma.listingVerification.count({
        where: { submittedByUserId: userId, status: 'ACCEPTED', ...(at ? { reviewedAt: at } : {}) },
      }),
    ]);
    return visits + verifications;
  },

  async sumCreditedIncentives(agentId, window) {
    const at = inside(window);
    const sum = await prisma.agentIncentive.aggregate({
      _sum: { amount: true },
      where: { agentId, status: 'CREDITED', ...(at ? { createdAt: at } : {}) },
    });
    return new Decimal(sum._sum.amount ?? 0);
  },

  async countOnTimeArrivals(agentId, window) {
    // The rating's own driver, read the way the rating reads it — a slot and
    // a check-in on the same order — so the QUALITY milestone and the rating
    // card can never disagree about what "on time" means.
    const at = inside(window);
    const orders = await prisma.order.findMany({
      where: { agentId, slotTime: { not: null }, checkIn: { isNot: null }, ...(at ? { slotTime: at } : {}) },
      select: { slotTime: true, checkIn: { select: { checkedInAt: true } } },
    });
    return orders.filter((order) => order.slotTime && order.checkIn && arrivedOnTime(order.slotTime, order.checkIn.checkedInAt)).length;
  },
};
