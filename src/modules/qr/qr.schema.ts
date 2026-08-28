import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const QR_TYPES = ['SITE', 'AD', 'AGENT', 'ORDER', 'PUBLISHER'] as const;

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

export const resolveQrSchema = z.object({
  token: z.string().min(1),
  role: upperEnum(SCANNING_ROLES).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});
