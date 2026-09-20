import { z } from 'zod';

export const partyTypeSchema = z.enum([
  'PUBLISHER',
  'ADVERTISER',
  'PARTNER',
  'EMPLOYEE',
  'AGENT',
  'TICKET',
  'FEEDBACK',
  'DISPUTE',
  'SAFETY',
  'LEAD',
  'USER',
  'VISIT',
  'CERTIFICATE',
  'FRAUD_CASE',
  'TASK',
  'ISSUE',
  'PROJECT',
]);

export const updateFormatSchema = z
  .object({
    prefix: z.string().min(1).max(8).regex(/^[A-Z0-9]+$/, 'Use capitals and digits only'),
    pattern: z.string().min(1).max(120),
    seqPadding: z.number().int().min(1).max(6),
    timeZone: z.string().min(1).max(64),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const previewSchema = z.object({
  prefix: z.string().min(1).max(8),
  pattern: z.string().min(1).max(120),
  seqPadding: z.number().int().min(1).max(6),
  timeZone: z.string().min(1).max(64),
});
