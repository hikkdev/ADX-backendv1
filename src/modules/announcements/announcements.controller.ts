import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { toListPage } from '../../shared/pagination';
import { announcementIdParamSchema, createAnnouncementSchema, listAnnouncementsQuerySchema, previewCountSchema, sendAnnouncementSchema } from './announcements.schema';
import { cancelAnnouncement, createAnnouncement, getAnnouncement, listAnnouncements, previewCount, previewCountFor, requestSend } from './announcements.service';

const MODULE = 'announcements';

function invalid(error: { flatten(): unknown }, what = 'request'): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', `Invalid ${what}`, error.flatten());
}

function idOf(req: Request): string {
  const params = announcementIdParamSchema.safeParse(req.params);
  if (!params.success) throw invalid(params.error, 'id');
  return params.data.id;
}

export async function listHandler(req: Request, res: Response): Promise<void> {
  const parsed = listAnnouncementsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error, 'query');
  const { q, status, audience, ...page } = parsed.data;
  const { items, total, counts } = await listAnnouncements({ q, status, audience }, page);
  res.json({ success: true, data: toListPage(items, total, counts, page) });
}

export async function createHandler(req: Request, res: Response): Promise<void> {
  const parsed = createAnnouncementSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const announcement = await createAnnouncement(parsed.data, req.user!.sub);
  await logActivity(req.user!.sub, 'ANNOUNCEMENT_CREATED', {
    req,
    module: MODULE,
    targetType: 'Announcement',
    targetId: announcement.id,
    metadata: { audience: announcement.audience, city: announcement.city, channels: announcement.channels, importance: announcement.importance },
  });
  res.status(201).json({ success: true, data: announcement });
}

export async function getHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getAnnouncement(idOf(req)) });
}

export async function previewCountHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await previewCount(idOf(req)) });
}

/** POST /announcements/preview-count — E10-2: the reach of a draft body, persisted nowhere. */
export async function previewDraftCountHandler(req: Request, res: Response): Promise<void> {
  const parsed = previewCountSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const { audience, city, channels, importance } = parsed.data;
  res.json({ success: true, data: await previewCountFor({ audience, city: city ?? null, channels, importance }) });
}

export async function sendHandler(req: Request, res: Response): Promise<void> {
  const id = idOf(req);
  const parsed = sendAnnouncementSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const { announcement, scheduled, at } = await requestSend(id, parsed.data.scheduledAt ?? null);
  await logActivity(req.user!.sub, scheduled ? 'ANNOUNCEMENT_SCHEDULED' : 'ANNOUNCEMENT_SEND_REQUESTED', {
    req,
    module: MODULE,
    targetType: 'Announcement',
    targetId: id,
    metadata: { at: at.toISOString(), audience: announcement.audience, channels: announcement.channels, importance: announcement.importance },
  });
  res.json({ success: true, data: announcement });
}

export async function cancelHandler(req: Request, res: Response): Promise<void> {
  const id = idOf(req);
  const { announcement, from } = await cancelAnnouncement(id);
  await logActivity(req.user!.sub, 'ANNOUNCEMENT_CANCELLED', {
    req,
    module: MODULE,
    targetType: 'Announcement',
    targetId: id,
    metadata: { from },
  });
  res.json({ success: true, data: announcement });
}
