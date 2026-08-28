import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../shared/errors';
import { upperEnum } from '../shared/validation';
import { prisma } from '../shared/database';
import { listActiveSessions, revokeSessionById } from '../modules/auth';
import { listActivity as listActivityLogs, logActivity } from '../shared/audit';
import { normalizeMobile } from '../modules/auth';
import type { Role } from '../shared/database';

export async function getMe(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true, agentProfile: true, publisherProfile: { include: { kyc: true } } },
  });

  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  res.json({
    success: true,
    data: {
      id: user.id,
      mobile: user.mobile,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      hasPassword: !!user.passwordHash,
      language: user.language,
      roles: user.roles.map((r) => r.role),
      agentProfile: user.agentProfile,
      publisherProfile: user.publisherProfile,
    },
  });
}

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  language: z.string().optional(),
  avatarUrl: z.string().url().optional(),
});

export async function updateMe(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: parsed.data,
    include: { roles: true, agentProfile: true, publisherProfile: { include: { kyc: true } } },
  });

  await logActivity(userId, 'PROFILE_UPDATED', req, { fields: Object.keys(parsed.data) });

  res.json({
    success: true,
    data: {
      id: user.id,
      mobile: user.mobile,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      hasPassword: !!user.passwordHash,
      language: user.language,
      roles: user.roles.map((r) => r.role),
      agentProfile: user.agentProfile,
      publisherProfile: user.publisherProfile,
    },
  });
}

// GET /users/me/sessions — active (non-revoked, non-expired) login sessions
export async function listMySessions(req: Request, res: Response): Promise<void> {
  const sessions = await listActiveSessions(req.user!.sub);
  res.json({ success: true, data: sessions });
}

// DELETE /users/me/sessions/:id — revoke a single session (e.g. "log out" a device)
export async function revokeMySession(req: Request, res: Response): Promise<void> {
  const revoked = await revokeSessionById(req.user!.sub, req.params.id as string);
  if (!revoked) throw new ApiError(404, 'NOT_FOUND', 'Session not found');
  await logActivity(req.user!.sub, 'SESSION_REVOKED', req, { sessionId: req.params.id });
  res.json({ success: true, data: { message: 'Session revoked' } });
}

// GET /users/me/activity — recent account activity
export async function listMyActivity(req: Request, res: Response): Promise<void> {
  const activity = await listActivityLogs(req.user!.sub);
  res.json({ success: true, data: activity });
}

// Admin: list all users with full profile info
export async function getAllUsers(req: Request, res: Response): Promise<void> {
  const users = await prisma.user.findMany({
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
  });

  res.json({
    success: true,
    data: users.map((u) => ({
      id: u.id,
      mobile: u.mobile,
      name: u.name,
      email: u.email,
      language: u.language,
      isActive: u.isActive,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      roles: u.roles.map((r) => r.role),
      agentProfile: u.agentProfile,
      publisherProfile: u.publisherProfile,
      placedOrders: u.placedOrders,
      onboardingSubmissions: u.onboardingSubmissions,
    })),
  });
}

// Admin: update another user's profile (name/email/mobile/active status)
const updateUserByAdminSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  mobile: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number').optional(),
  isActive: z.boolean().optional(),
});

export async function updateUserByAdmin(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;
  const parsed = updateUserByAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  if (parsed.data.isActive === false && id === req.user!.sub) {
    throw new ApiError(400, 'BAD_REQUEST', 'You cannot deactivate your own account');
  }

  const { mobile: rawMobile, ...rest } = parsed.data;
  const mobile = rawMobile ? normalizeMobile(rawMobile) : undefined;

  if (mobile && mobile !== target.mobile) {
    const existing = await prisma.user.findUnique({ where: { mobile } });
    if (existing) throw new ApiError(409, 'CONFLICT', 'A user with this mobile number already exists');
  }
  if (rest.email && rest.email !== target.email) {
    const existing = await prisma.user.findUnique({ where: { email: rest.email } });
    if (existing) throw new ApiError(409, 'CONFLICT', 'A user with this email already exists');
  }

  const user = await prisma.user.update({
    where: { id },
    data: { ...rest, ...(mobile ? { mobile } : {}) },
    include: { roles: true },
  });

  let action = 'PROFILE_UPDATED_BY_ADMIN';
  if (parsed.data.isActive === false) action = 'ACCOUNT_DEACTIVATED';
  else if (parsed.data.isActive === true) action = 'ACCOUNT_ACTIVATED';

  await logActivity(id, action, req, { updatedBy: req.user!.sub, fields: Object.keys(parsed.data) });

  res.json({
    success: true,
    data: {
      id: user.id,
      mobile: user.mobile,
      name: user.name,
      email: user.email,
      isActive: user.isActive,
      roles: user.roles.map((r) => r.role),
    },
  });
}

// Admin: delete a user
export async function deleteUser(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;

  if (id === req.user!.sub) {
    throw new ApiError(400, 'BAD_REQUEST', 'You cannot delete your own account');
  }

  const user = await prisma.user.findUnique({ where: { id }, include: { roles: true, agentProfile: true, publisherProfile: true } });
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const isAdmin = user.roles.some((r) => r.role === 'ADMIN');
  if (isAdmin) {
    const adminCount = await prisma.userRole.count({ where: { role: 'ADMIN' } });
    if (adminCount <= 1) {
      throw new ApiError(400, 'BAD_REQUEST', 'Cannot delete the last remaining Super Admin');
    }
  }

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

  // The deleted user's own activity log is cascade-deleted with them, so
  // record this against the acting admin's log instead.
  await logActivity(req.user!.sub, 'USER_DELETED', req, { deletedUserId: id, deletedUserMobile: user.mobile, wasAdmin: isAdmin });

  res.json({ success: true, data: { message: 'User deleted' } });
}

// Admin: create a new user with at least one role
const createUserSchema = z.object({
  mobile: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number'),
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  roles: z
    .array(upperEnum(['AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'PUBLISHER', 'ADVERTISER', 'PARTNER', 'ADMIN'] as const))
    .min(1, 'At least one role is required'),
});

export async function createUser(req: Request, res: Response): Promise<void> {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const mobile = normalizeMobile(parsed.data.mobile);
  const { name, email, roles } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { mobile } });
  if (existing) throw new ApiError(409, 'CONFLICT', 'A user with this mobile number already exists');

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({ data: { mobile, name, email } });

    await tx.userRole.createMany({
      data: roles.map((role) => ({ userId: created.id, role: role as Role })),
    });

    const isAgent = roles.some((r) => r === 'AGENT_PUBLISHER' || r === 'AGENT_ADVERTISER');
    if (isAgent) {
      await tx.agentProfile.create({ data: { userId: created.id } });
    }

    return created;
  });

  res.status(201).json({ success: true, data: { id: user.id, mobile: user.mobile, name: user.name, roles } });
}

// Bootstrap: assign ADMIN to a user only when no admins exist yet
export async function bootstrapAdmin(req: Request, res: Response): Promise<void> {
  const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const existingAdmin = await prisma.userRole.findFirst({ where: { role: 'ADMIN' } });
  if (existingAdmin) {
    throw new ApiError(403, 'FORBIDDEN', 'Admin already exists — use /users/roles to assign roles');
  }

  await prisma.userRole.create({ data: { userId: parsed.data.userId, role: 'ADMIN' } });
  res.json({ success: true, data: { message: 'Admin bootstrapped' } });
}

// Admin: assign a role to a user
const assignRoleSchema = z.object({
  userId: z.string().min(1),
  role: upperEnum(['AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'PUBLISHER', 'ADVERTISER', 'PARTNER', 'ADMIN'] as const),
});

export async function assignRole(req: Request, res: Response): Promise<void> {
  const parsed = assignRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { userId, role } = parsed.data;

  await prisma.userRole.upsert({
    where: { userId_role: { userId, role: role as Role } },
    update: {},
    create: { userId, role: role as Role },
  });

  // Ensure agent profile exists for agent roles
  if (role === 'AGENT_PUBLISHER' || role === 'AGENT_ADVERTISER') {
    await prisma.agentProfile.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  res.json({ success: true, data: { message: `Role ${role} assigned` } });
}
