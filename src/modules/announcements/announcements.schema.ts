import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { ANNOUNCEMENT_SORTS, ANNOUNCEMENT_STATUSES } from './announcements.repository';

export const ANNOUNCEMENT_AUDIENCES = ['ALL', 'PUBLISHERS', 'ADVERTISERS', 'AGENTS'] as const;
export const ANNOUNCEMENT_IMPORTANCES = ['NORMAL', 'CRITICAL'] as const;
/** G10: PUSH is a real channel now — the dispatcher's push rail (G6) carries it. */
const CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] as const;

export const listAnnouncementsQuerySchema = listQuerySchema(ANNOUNCEMENT_STATUSES, ANNOUNCEMENT_SORTS).extend({
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
});

export const createAnnouncementSchema = z.object({
  title: z.string().trim().min(3).max(140),
  body: z.string().trim().min(3).max(4_000),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).default('ALL'),
  city: z.string().trim().max(80).nullable().optional(),
  channels: z.array(z.enum(CHANNELS)).min(1).default(['IN_APP']),
  importance: z.enum(ANNOUNCEMENT_IMPORTANCES).default('NORMAL'),
  scheduledAt: z.coerce.date().nullable().optional(),
});

/** E10-2: `POST /announcements/preview-count` — the draft's audience and channels, nothing else. */
export const previewCountSchema = createAnnouncementSchema.pick({ audience: true, city: true, channels: true, importance: true });

export const sendAnnouncementSchema = z.object({
  /** Absent or past: now. */
  scheduledAt: z.coerce.date().nullable().optional(),
});

export const announcementIdParamSchema = z.object({ id: z.string().trim().min(1).max(64) });
