import { prisma } from '../../../shared/database';
import type { FleetInviteStatus } from '../../../shared/database';
import type { FleetPartnerPatch, FleetRepository, NewFleetPartner } from './fleet.repository';

export const prismaFleetRepository: FleetRepository = {
  createPartner(input: NewFleetPartner) {
    return prisma.fleetPartner.create({ data: input });
  },

  updatePartner(partnerId, patch: FleetPartnerPatch) {
    return prisma.fleetPartner.update({ where: { id: partnerId }, data: patch });
  },

  findPartner(partnerId) {
    return prisma.fleetPartner.findUnique({ where: { id: partnerId } });
  },

  async listPartners() {
    const rows = await prisma.fleetPartner.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { invites: { select: { status: true } } },
    });
    return rows.map(({ invites, ...partner }) => ({
      ...partner,
      invites: {
        sent: invites.length,
        applied: invites.filter((i) => i.status === 'APPLIED' || i.status === 'ACTIVATED').length,
        activated: invites.filter((i) => i.status === 'ACTIVATED').length,
      },
    }));
  },

  listInvites(partnerId) {
    return prisma.fleetInvite.findMany({
      where: { partnerId },
      orderBy: { sentAt: 'desc' },
      include: { agent: { select: { id: true, displayId: true, stage: true, user: { select: { name: true } } } } },
    });
  },

  async addInvites(partnerId, rows, sentById) {
    const existing = await prisma.fleetInvite.findMany({ where: { partnerId, mobile: { in: rows.map((r) => r.mobile) } }, select: { mobile: true } });
    const held = new Set(existing.map((r) => r.mobile));
    const fresh = rows.filter((r) => !held.has(r.mobile));
    if (fresh.length === 0) return [];
    await prisma.fleetInvite.createMany({ data: fresh.map((r) => ({ partnerId, mobile: r.mobile, name: r.name, sentById })) });
    return prisma.fleetInvite.findMany({ where: { partnerId, mobile: { in: fresh.map((r) => r.mobile) } } });
  },

  findOpenInviteByMobile(mobile) {
    return prisma.fleetInvite.findFirst({
      where: { mobile, status: 'SENT', partner: { isActive: true } },
      orderBy: { sentAt: 'desc' },
      include: { partner: { select: { id: true, name: true } } },
    });
  },

  async setInviteStatus(inviteId, status: FleetInviteStatus, agentId, appliedAt) {
    await prisma.fleetInvite.update({ where: { id: inviteId }, data: { status, agentId, ...(appliedAt ? { appliedAt } : {}) } });
  },

  findInviteByAgent(agentId) {
    return prisma.fleetInvite.findFirst({ where: { agentId }, orderBy: { sentAt: 'desc' } });
  },

  async userMobile(userId) {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { mobile: true } });
    return row?.mobile ?? null;
  },
};
