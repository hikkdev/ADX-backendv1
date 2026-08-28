import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const KYC_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;

/**
 * Admin review decision. Identical for advertiser and user KYC, which is the
 * main reason the two live in one module.
 */
export const reviewSchema = z.object({
  status: upperEnum(KYC_STATUSES),
  rejectionReason: z.string().optional(),
});

export type ReviewInput = z.infer<typeof reviewSchema>;

/** Page/pageSize parsing shared by both admin listings. */
export function pagination(query: Record<string, unknown>) {
  return {
    page: Math.max(1, Number(query['page'] ?? 1)),
    pageSize: Math.min(100, Math.max(1, Number(query['pageSize'] ?? 20))),
  };
}

export function pageMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
