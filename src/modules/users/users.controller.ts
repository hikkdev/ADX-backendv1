import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { listActivity as listActivityLogs, logActivity } from '../../shared/audit';
import { listActiveSessions, revokeSessionById } from '../auth';
import type { Role } from '../../shared/database';
import {
  assignRoleSchema,
  bootstrapAdminSchema,
  createUserSchema,
  updateProfileSchema,
  updateUserByAdminSchema,
} from './users.schema';
import { adminListPayload, adminUpdatePayload, profilePayload } from './users.mapper';
import * as service from './users.service';

export async function getMe(req: Request, res: Response): Promise<void> {
  const user = await service.getProfile(req.user!.sub);
  res.json({ success: true, data: profilePayload(user) });
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const user = await service.updateProfile(userId, parsed.data);
  await logActivity(userId, 'PROFILE_UPDATED', req, { fields: Object.keys(parsed.data) });

  res.json({ success: true, data: profilePayload(user) });
}

// GET /users/me/sessions — active (non-revoked, non-expired) login sessions
export async function listMySessions(req: Request, res: Response): Promise<void> {
  const sessions = await listActiveSessions(req.user!.sub);
  res.json({ success: true, data: sessions });
}

// DELETE /users/me/sessions/:id — revoke a single session (e.g. "log out" a device)
export async function revokeMySession(req: Request, res: Response): Promise<void> {
  const sessionId = req.params['id'] as string;
  const revoked = await revokeSessionById(req.user!.sub, sessionId);
  if (!revoked) throw new ApiError(404, 'NOT_FOUND', 'Session not found');
  await logActivity(req.user!.sub, 'SESSION_REVOKED', req, { sessionId });
  res.json({ success: true, data: { message: 'Session revoked' } });
}

// GET /users/me/activity — recent account activity
export async function listMyActivity(req: Request, res: Response): Promise<void> {
  const activity = await listActivityLogs(req.user!.sub);
  res.json({ success: true, data: activity });
}

export async function getAllUsers(_req: Request, res: Response): Promise<void> {
  const users = await service.listUsersForAdmin();
  res.json({ success: true, data: users.map(adminListPayload) });
}

export async function updateUserByAdmin(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const parsed = updateUserByAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const user = await service.updateUserByAdmin(id, req.user!.sub, parsed.data);

  // Logged against the edited user, not the acting admin, with the actor
  // recorded in the metadata.
  await logActivity(id, service.adminUpdateAction(parsed.data), req, {
    updatedBy: req.user!.sub,
    fields: Object.keys(parsed.data),
  });

  res.json({ success: true, data: adminUpdatePayload(user) });
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  const id = req.params['id'] as string;
  const { mobile, wasAdmin } = await service.deleteUser(id, req.user!.sub);

  // The deleted user's own activity log is cascade-deleted with them, so
  // record this against the acting admin's log instead.
  await logActivity(req.user!.sub, 'USER_DELETED', req, {
    deletedUserId: id,
    deletedUserMobile: mobile,
    wasAdmin,
  });

  res.json({ success: true, data: { message: 'User deleted' } });
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const roles = parsed.data.roles as Role[];
  const user = await service.createUser({ ...parsed.data, roles });

  res.status(201).json({
    success: true,
    data: { id: user.id, mobile: user.mobile, name: user.name, roles },
  });
}

export async function bootstrapAdmin(req: Request, res: Response): Promise<void> {
  const parsed = bootstrapAdminSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  await service.bootstrapAdmin(parsed.data.userId);
  res.json({ success: true, data: { message: 'Admin bootstrapped' } });
}

export async function assignRole(req: Request, res: Response): Promise<void> {
  const parsed = assignRoleSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { userId, role } = parsed.data;
  await service.assignRole(userId, role as Role);

  res.json({ success: true, data: { message: `Role ${role} assigned` } });
}
