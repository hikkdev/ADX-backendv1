import { z } from 'zod';

export const createRoleConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(z.string()).default([]),
});

export const updateRoleConfigSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

/**
 * PUT /users/:id/role-config — which console role this person holds.
 *
 * `null` removes it, which is not the same as having none: an ADMIN with no
 * role config holds every permission (the launch rule), so removing one is a
 * widening, and it is audited like any other change.
 */
export const assignRoleConfigSchema = z.object({
  roleConfigId: z.string().min(1).nullable(),
});

export type CreateRoleConfigInput = z.infer<typeof createRoleConfigSchema>;
export type UpdateRoleConfigInput = z.infer<typeof updateRoleConfigSchema>;
export type AssignRoleConfigInput = z.infer<typeof assignRoleConfigSchema>;
