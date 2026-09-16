import { z } from 'zod';

export const createUserKycSchema = z.object({
  selfVideoUrl: z.string().url(),
  // ADMIN-only: submit on behalf of a specific user rather than the caller's own.
  userId: z.string().optional(),
});

export type CreateUserKycInput = z.infer<typeof createUserKycSchema>;

/** Lot D (Q131): the liveness video, by the private file the phone uploaded (purpose USER_KYC). */
export const livenessSchema = z.object({
  fileId: z.string().trim().min(1).max(64),
});

/**
 * Lot N: an admin attests the person's presence instead of a video — the
 * note says how ("met in person at the Pune desk", "video call on 14 Sep")
 * and is kept on the row and in the audit trail.
 */
export const attestationSchema = z.object({
  note: z.string().trim().min(3, 'Say how the person was met').max(500),
});
export type AttestationInput = z.infer<typeof attestationSchema>;
