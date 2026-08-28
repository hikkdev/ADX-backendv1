import { z } from 'zod';

export const createUserKycSchema = z.object({
  selfVideoUrl: z.string().url(),
  // ADMIN-only: submit on behalf of a specific user rather than the caller's own.
  userId: z.string().optional(),
});

export type CreateUserKycInput = z.infer<typeof createUserKycSchema>;
