import { z } from 'zod';
import { upperEnum } from '../../shared/validation';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../shared/pagination';

export const QR_TYPES = ['SITE', 'AD', 'AGENT', 'ORDER', 'PUBLISHER', 'ACCESS_GRANT', 'ADVERTISER'] as const;

// ADMIN is scannable but PARTNER is not — the allowed-role list is narrower
// than the full Role enum on purpose.
export const SCANNING_ROLES = [
  'AGENT_PUBLISHER',
  'AGENT_ADVERTISER',
  'PUBLISHER',
  'ADVERTISER',
  'ADMIN',
] as const;

export const generateQrSchema = z.object({
  type: upperEnum(QR_TYPES),
  refId: z.string().min(1),
  allowedRoles: z.array(upperEnum(SCANNING_ROLES)).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** QR-27: what an agent asks for when they scan an onboarded account's code. */
export const accessAskSchema = z.object({
  scope: z.enum(['PROFILE', 'LISTINGS']),
  reason: z.string().trim().max(200).default(''),
  durationMinutes: z.number().int().min(15).max(24 * 60).default(4 * 60),
});

export const resolveQrSchema = z.object({
  token: z.string().min(1),
  role: upperEnum(SCANNING_ROLES).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  ask: accessAskSchema.optional(),
});

/* ── K-B1: the QR desk ─────────────────────────────────────────── */

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE);
const boolean = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

/** `GET /qr?type=&active=&refId=&q=&page&pageSize` — the desk's list. `q` is a contains over refId and id. */
export const qrListQuerySchema = z.object({
  type: upperEnum(QR_TYPES).optional(),
  active: boolean,
  refId: z.string().trim().min(1).max(120).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page,
  pageSize,
});
export type QrListQuery = z.infer<typeof qrListQuerySchema>;

/** `GET /qr/:qrId/scans?page&pageSize&outcome=` — one code's scans, the list contract. */
export const qrScansQuerySchema = z.object({
  outcome: z.string().trim().min(1).max(40).optional(),
  page,
  pageSize,
});
export type QrScansQuery = z.infer<typeof qrScansQuerySchema>;

/**
 * `GET /qr/scans?scannedById=&outcome=&from=&to=` — ops' view of one
 * person's scans. `scannedBy` is the D6 spelling the console still sends.
 */
export const scansByQuerySchema = z
  .object({
    scannedById: z.string().trim().min(1).optional(),
    scannedBy: z.string().trim().min(1).optional(),
    outcome: z.string().trim().min(1).max(40).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .transform((value) => ({ ...value, scannedById: value.scannedById ?? value.scannedBy }));

/** `DELETE /qr/:qrId { reason }` — the desk's word, on the audit row. */
export const deactivateQrSchema = z.object({ reason: z.string().trim().min(5).max(500) });
