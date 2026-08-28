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

export type CreateRoleConfigInput = z.infer<typeof createRoleConfigSchema>;
export type UpdateRoleConfigInput = z.infer<typeof updateRoleConfigSchema>;
