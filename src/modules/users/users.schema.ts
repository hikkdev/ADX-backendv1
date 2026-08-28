import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const ASSIGNABLE_ROLES = [
  'AGENT_PUBLISHER',
  'AGENT_ADVERTISER',
  'PUBLISHER',
  'ADVERTISER',
  'PARTNER',
  'ADMIN',
] as const;

const mobileNumber = z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number');

export const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  language: z.string().optional(),
  avatarUrl: z.string().url().optional(),
});

export const updateUserByAdminSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  mobile: mobileNumber.optional(),
  isActive: z.boolean().optional(),
});

export const createUserSchema = z.object({
  mobile: mobileNumber,
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  roles: z.array(upperEnum(ASSIGNABLE_ROLES)).min(1, 'At least one role is required'),
});

export const bootstrapAdminSchema = z.object({ userId: z.string().min(1) });

export const assignRoleSchema = z.object({
  userId: z.string().min(1),
  role: upperEnum(ASSIGNABLE_ROLES),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type UpdateUserByAdminInput = z.infer<typeof updateUserByAdminSchema>;
