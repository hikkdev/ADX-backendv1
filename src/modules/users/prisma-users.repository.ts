import { prisma } from '../../shared/database';
import type { Role } from '../../shared/database';
import type { DeletionTarget, UsersRepository } from './users.repository';
import type { UpdateProfileInput, UpdateUserByAdminInput } from './users.schema';

const profileInclude = {
  roles: true,
  agentProfile: true,
  publisherProfile: { include: { kyc: true } },
} as const;

export const prismaUsersRepository: UsersRepository = {
  findProfile(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, include: profileInclude }) as never;
  },

  updateProfile(userId: string, data: UpdateProfileInput) {
    return prisma.user.update({ where: { id: userId }, data, include: profileInclude }) as never;
  },

  findAllForAdmin() {
    return prisma.user.findMany({
      include: {
        roles: true,
        agentProfile: true,
        // Nested so the admin panel can show Publisher KYC status/documents for
        // business visibility without needing the agent-scoped /publishers
        // endpoints — actual KYC review stays agent-mediated (QR-claim flow in
        // the Publisher/Agent apps), the admin panel only ever reads this.
        publisherProfile: { include: { kyc: true, listings: true, sites: true } },
        placedOrders: { select: { id: true, status: true, createdAt: true } },
        onboardingSubmissions: {
          include: { flowTemplate: true },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    }) as never;
  },

  findById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  findByMobile(mobile: string) {
    return prisma.user.findUnique({ where: { mobile } });
  },

  findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  updateByAdmin(userId: string, data: UpdateUserByAdminInput) {
    return prisma.user.update({ where: { id: userId }, data, include: { roles: true } }) as never;
  },

  findDeletionTarget(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true, agentProfile: true, publisherProfile: true },
    }) as never;
  },

  countAdmins() {
    return prisma.userRole.count({ where: { role: 'ADMIN' } });
  },

  async deleteUserCascade(user: DeletionTarget) {
    const id = user.id;

    // One transaction end to end. The rows below live in other modules'
    // tables, but the delete has to be atomic: a partial cascade would leave
    // orders pointing at a user that no longer exists. See README.
    await prisma.$transaction(async (tx) => {
      const orderIds = new Set<string>();

      const advertiserOrders = await tx.order.findMany({
        where: { advertiserId: id },
        select: { id: true },
      });
      advertiserOrders.forEach((order) => orderIds.add(order.id));

      if (user.agentProfile) {
        const agentOrders = await tx.order.findMany({
          where: { agentId: user.agentProfile.id },
          select: { id: true },
        });
        agentOrders.forEach((order) => orderIds.add(order.id));
      }

      if (user.publisherProfile || user.agentProfile) {
        const listingWhere = {
          OR: [
            ...(user.publisherProfile ? [{ publisherId: user.publisherProfile.id }] : []),
            ...(user.agentProfile ? [{ agentId: user.agentProfile.id }] : []),
          ],
        };
        const listings = listingWhere.OR.length
          ? await tx.listing.findMany({ where: listingWhere, select: { id: true } })
          : [];
        if (listings.length) {
          const listingOrders = await tx.order.findMany({
            where: { listingId: { in: listings.map((listing) => listing.id) } },
            select: { id: true },
          });
          listingOrders.forEach((order) => orderIds.add(order.id));
        }
      }

      const orderIdList = [...orderIds];
      if (orderIdList.length) {
        const milestones = await tx.orderMilestone.findMany({
          where: { orderId: { in: orderIdList } },
          select: { id: true },
        });
        const milestoneIds = milestones.map((milestone) => milestone.id);
        if (milestoneIds.length) {
          await tx.orderMilestoneEvidence.deleteMany({ where: { milestoneId: { in: milestoneIds } } });
        }
        await tx.orderMilestone.deleteMany({ where: { orderId: { in: orderIdList } } });
        await tx.orderAgentAssignment.deleteMany({ where: { orderId: { in: orderIdList } } });
        await tx.checkIn.deleteMany({ where: { orderId: { in: orderIdList } } });
        await tx.siteVerification.deleteMany({ where: { orderId: { in: orderIdList } } });
        await tx.order.deleteMany({ where: { id: { in: orderIdList } } });
      }

      if (user.publisherProfile || user.agentProfile) {
        const listingWhere = {
          OR: [
            ...(user.publisherProfile ? [{ publisherId: user.publisherProfile.id }] : []),
            ...(user.agentProfile ? [{ agentId: user.agentProfile.id }] : []),
          ],
        };
        if (listingWhere.OR.length) {
          await tx.listing.deleteMany({ where: listingWhere });
        }
      }

      if (user.publisherProfile) {
        await tx.site.deleteMany({ where: { publisherId: user.publisherProfile.id } });
        await tx.publisher.delete({ where: { id: user.publisherProfile.id } });
      }

      if (user.agentProfile) {
        await tx.orderMilestone.updateMany({
          where: { assignedAgentId: user.agentProfile.id },
          data: { assignedAgentId: null },
        });
        await tx.order.updateMany({
          where: { agentId: user.agentProfile.id },
          data: { agentId: null },
        });
        await tx.orderAgentAssignment.deleteMany({ where: { agentId: user.agentProfile.id } });
        await tx.transaction.deleteMany({ where: { agentId: user.agentProfile.id } });
        await tx.agentMilestone.deleteMany({ where: { agentId: user.agentProfile.id } });
        await tx.publisher.updateMany({
          where: { agentId: user.agentProfile.id },
          data: { agentId: null },
        });
        await tx.agentProfile.delete({ where: { id: user.agentProfile.id } });
      }

      await tx.qrScan.deleteMany({ where: { scannedById: id } });
      await tx.ticketMessage.deleteMany({ where: { authorId: id } });
      await tx.supportTicket.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
    });
  },

  createWithRoles({ mobile, name, email, roles }) {
    return prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { mobile, name, email } });

      await tx.userRole.createMany({
        data: roles.map((role) => ({ userId: created.id, role })),
      });

      const isAgent = roles.some((r) => r === 'AGENT_PUBLISHER' || r === 'AGENT_ADVERTISER');
      if (isAgent) {
        await tx.agentProfile.create({ data: { userId: created.id } });
      }

      return created;
    });
  },

  findAnyAdminRole() {
    return prisma.userRole.findFirst({ where: { role: 'ADMIN' } });
  },

  findAdminUserIds() {
    return prisma.userRole.findMany({ where: { role: 'ADMIN' }, select: { userId: true } });
  },

  grantAdmin(userId: string) {
    return prisma.userRole.create({ data: { userId, role: 'ADMIN' } });
  },

  grantRole(userId: string, role: Role) {
    return prisma.userRole.upsert({
      where: { userId_role: { userId, role } },
      update: {},
      create: { userId, role },
    });
  },

  ensureAgentProfile(userId: string) {
    return prisma.agentProfile.upsert({ where: { userId }, update: {}, create: { userId } });
  },
};
