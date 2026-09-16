import { prisma } from '../../../shared/database';
import type { AdminInvite, AdminInviteMethod, Role, User } from '../../../shared/database';

/** An invite with the person who sent it, for the console list. */
export type InviteRow = AdminInvite & {
  invitedBy: { id: string; name: string | null; email: string | null };
};

export interface InvitesRepository {
  findOpenByEmail(email: string, now: Date): Promise<AdminInvite | null>;
  findById(id: string): Promise<AdminInvite | null>;
  findByTokenHash(tokenHash: string): Promise<AdminInvite | null>;
  list(): Promise<InviteRow[]>;
  create(data: {
    email: string;
    method: AdminInviteMethod;
    roleConfigId: string | null;
    tokenHash: string;
    invitedByUserId: string;
    expiresAt: Date;
  }): Promise<AdminInvite>;
  /** A resend re-rolls the token and pushes the expiry out; the row stays the same. */
  refresh(id: string, tokenHash: string, expiresAt: Date): Promise<AdminInvite>;
  revoke(id: string): Promise<AdminInvite>;
  roleConfigExists(roleConfigId: string): Promise<boolean>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserById(userId: string): Promise<User | null>;
  /**
   * Turns the placeholder row the OTP send created into the admin account,
   * and closes the invite — in one transaction, because an account promoted
   * without its invite being closed could be created twice from one link.
   */
  promoteInvitee(data: {
    inviteId: string;
    userId: string;
    email: string;
    name: string;
    passwordHash: string | null;
    roleConfigId: string | null;
  }): Promise<User & { roles: { role: Role }[] }>;
}

export const prismaInvitesRepository: InvitesRepository = {
  findOpenByEmail(email: string, now: Date) {
    return prisma.adminInvite.findFirst({
      where: { email, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
  },

  findById(id: string) {
    return prisma.adminInvite.findUnique({ where: { id } });
  },

  findByTokenHash(tokenHash: string) {
    return prisma.adminInvite.findUnique({ where: { tokenHash } });
  },

  list() {
    return prisma.adminInvite.findMany({
      orderBy: { createdAt: 'desc' },
      include: { invitedBy: { select: { id: true, name: true, email: true } } },
    });
  },

  create(data) {
    return prisma.adminInvite.create({ data });
  },

  refresh(id: string, tokenHash: string, expiresAt: Date) {
    return prisma.adminInvite.update({ where: { id }, data: { tokenHash, expiresAt } });
  },

  revoke(id: string) {
    return prisma.adminInvite.update({ where: { id }, data: { revokedAt: new Date() } });
  },

  async roleConfigExists(roleConfigId: string) {
    return (await prisma.roleConfig.count({ where: { id: roleConfigId } })) > 0;
  },

  findUserByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  findUserById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  },

  promoteInvitee({ inviteId, userId, email, name, passwordHash, roleConfigId }) {
    return prisma.$transaction(async (tx) => {
      // The OTP send gave the placeholder the PUBLISHER role, because that is
      // what a self-registration is. This is not one: the row becomes an admin
      // and nothing else.
      await tx.userRole.deleteMany({ where: { userId } });

      const user = await tx.user.update({
        where: { id: userId },
        data: {
          email,
          name,
          passwordHash,
          // The code that just landed proved the number, and an admin's second
          // factor is on from the first sign-in.
          mobileVerifiedAt: new Date(),
          twoFactorRequiredAt: new Date(),
          roles: { create: { role: 'ADMIN' } },
        },
        include: { roles: true },
      });

      if (roleConfigId) {
        await tx.userRoleConfig.create({ data: { userId, roleConfigId } });
      }

      await tx.adminInvite.update({
        where: { id: inviteId },
        data: { acceptedAt: new Date(), acceptedUserId: userId },
      });

      return user;
    }) as never;
  },
};
