import { ApiError } from '../../shared/errors';
import { logActivity } from '../../shared/audit';
import { logger } from '../../shared/logging';
import { isSmsKindRegistered } from '../../shared/sms';
import type { Announcement, AnnouncementStatus, NotificationChannel } from '../../shared/database';
import type { ListQuery } from '../../shared/pagination';
import { notify, unsubscribeUrlFor } from '../notifications';
import { prismaAnnouncementsRepository as repository } from './prisma-announcements.repository';
import type { AnnouncementFilter, AudienceMember, DeliveryMark, NewAnnouncement } from './announcements.repository';

/**
 * Announcements — Lot E (Q64/Q130): a broadcast from ops.
 *
 * In-app always: the row in the bell is the record. Email to everyone in the
 * audience with an address who has not unsubscribed. Push (G10) to everyone
 * with a device on file, through the dispatcher's push rail. SMS only when the
 * announcement is CRITICAL — a service notice, never a promotion (Q130) —
 * and only when the ANNOUNCEMENT_CRITICAL kind is registered on a rail,
 * because an unregistered kind is a skipped send and a bill.
 *
 * The desk writes a DRAFT, asks for a preview count, and presses send: now,
 * or at a time. The fan-out itself is the job's — batches of 500 through the
 * dispatcher, each (person, channel) marked once, so a process that dies
 * mid-way resumes without a second email to anyone.
 */

export const BATCH_SIZE = 500;
export const ANNOUNCEMENT_EVENT = 'ANNOUNCEMENT';
const IST_OFFSET_MINUTES = 330;

/** 21:00–09:00 IST. Reserved for the day a NORMAL announcement may carry SMS; CRITICAL ignores it. */
export function isSmsQuietHour(now: Date): boolean {
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + IST_OFFSET_MINUTES) % (24 * 60);
  const hour = Math.floor(istMinutes / 60);
  return hour >= 21 || hour < 9;
}

/** Q130: a NORMAL announcement never reaches SMS. The switch is here so the quiet-hours rule below is already wired the day it widens. */
const NORMAL_SMS_ALLOWED = false;

/** Whether SMS may go for this announcement at this moment: CRITICAL whatever the hour, NORMAL never (Q130). */
export function smsAllowed(announcement: Pick<Announcement, 'importance' | 'channels'>, now: Date): boolean {
  if (!announcement.channels.includes('SMS')) return false;
  if (announcement.importance === 'CRITICAL') return true;
  return NORMAL_SMS_ALLOWED && !isSmsQuietHour(now);
}

function assertChannels(channels: NotificationChannel[], importance: 'NORMAL' | 'CRITICAL'): NotificationChannel[] {
  if (channels.includes('SMS') && importance !== 'CRITICAL') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'SMS is only for CRITICAL announcements — service notices, never promotion (Q130).');
  }
  // G10: PUSH goes through the dispatcher's push rail like email and SMS.
  // In-app is the record and always goes.
  return channels.includes('IN_APP') ? channels : ['IN_APP', ...channels];
}

/* ── the desk ────────────────────────────────────────────────────── */

export type CreateAnnouncementInput = Omit<NewAnnouncement, 'createdById' | 'channels' | 'city' | 'scheduledAt'> & {
  channels: NotificationChannel[];
  city?: string | null | undefined;
  scheduledAt?: Date | null | undefined;
};

export async function createAnnouncement(input: CreateAnnouncementInput, actorId: string): Promise<Announcement> {
  const channels = assertChannels(input.channels, input.importance);
  return repository.create({
    title: input.title,
    body: input.body,
    audience: input.audience,
    city: input.city?.trim() || null,
    channels,
    importance: input.importance,
    scheduledAt: input.scheduledAt ?? null,
    createdById: actorId,
  });
}

export function listAnnouncements(filter: AnnouncementFilter, page: ListQuery) {
  return repository.list(filter, page);
}

export async function getAnnouncement(id: string): Promise<Announcement> {
  const row = await repository.findById(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Announcement not found');
  return row;
}

export interface PreviewCount {
  audience: number;
  inApp: number;
  email: number;
  sms: number;
  /** G11-2: the devices on file across the audience, when PUSH is a channel; else 0. */
  push: number;
  /** Why SMS is zero, when it is. */
  smsNote: string | null;
}

/** E10-2: what the preview needs of an announcement — a stored row or the desk's unsaved draft. */
export type PreviewSubject = Pick<Announcement, 'audience' | 'city' | 'channels' | 'importance'>;

/** Per channel, how many people this would reach if sent now. */
export async function previewCount(id: string, now = new Date()): Promise<PreviewCount> {
  return previewCountFor(await getAnnouncement(id), now);
}

/**
 * E10-2: the same answer over a draft body, nothing persisted — the desk
 * shows the reach while the announcement is still being typed. A NORMAL
 * draft naming SMS is not refused here the way `createAnnouncement` refuses
 * it; it answers zero with the reason, which is what the desk wants to print.
 */
export async function previewCountFor(announcement: PreviewSubject, now = new Date()): Promise<PreviewCount> {
  const counts = await repository.audienceCounts(announcement.audience, announcement.city);
  let sms = 0;
  let smsNote: string | null = null;
  if (!announcement.channels.includes('SMS')) {
    smsNote = null;
  } else if (!smsAllowed(announcement, now)) {
    smsNote = 'SMS goes only with CRITICAL announcements (Q130).';
  } else if (!(await isSmsKindRegistered('ANNOUNCEMENT_CRITICAL'))) {
    smsNote = 'The ANNOUNCEMENT_CRITICAL SMS kind is not registered on any rail yet.';
  } else {
    sms = counts.withMobile;
  }
  return {
    audience: counts.total,
    inApp: counts.total,
    email: announcement.channels.includes('EMAIL') ? counts.withEmail : 0,
    sms,
    push: announcement.channels.includes('PUSH') ? counts.devices : 0,
    smsNote,
  };
}

const SENDABLE: readonly AnnouncementStatus[] = ['DRAFT', 'SCHEDULED'];

/** POST /:id/send — now, or at `scheduledAt`. The job does the rest; the controller audits. */
export async function requestSend(id: string, scheduledAt: Date | null, now = new Date()): Promise<{ announcement: Announcement; scheduled: boolean; at: Date }> {
  const announcement = await getAnnouncement(id);
  if (!SENDABLE.includes(announcement.status)) {
    throw new ApiError(409, 'CONFLICT', `An announcement that is ${announcement.status} cannot be sent.`);
  }
  const scheduled = Boolean(scheduledAt && scheduledAt.getTime() > now.getTime());
  const at = scheduled ? scheduledAt! : now;
  const moved = await repository.transition(id, SENDABLE, scheduled ? 'SCHEDULED' : 'SENDING', { scheduledAt: at });
  if (!moved) throw new ApiError(409, 'CONFLICT', 'The announcement moved while you were sending it.');
  return { announcement: await getAnnouncement(id), scheduled, at };
}

const CANCELLABLE: readonly AnnouncementStatus[] = ['DRAFT', 'SCHEDULED', 'SENDING'];

/** POST /:id/cancel — stops a scheduled send, or a running one between batches. The controller audits. */
export async function cancelAnnouncement(id: string): Promise<{ announcement: Announcement; from: AnnouncementStatus }> {
  const announcement = await getAnnouncement(id);
  if (!CANCELLABLE.includes(announcement.status)) {
    throw new ApiError(409, 'CONFLICT', `An announcement that is ${announcement.status} cannot be cancelled.`);
  }
  const moved = await repository.transition(id, CANCELLABLE, 'CANCELLED');
  if (!moved) throw new ApiError(409, 'CONFLICT', 'The announcement moved while you were cancelling it.');
  return { announcement: await getAnnouncement(id), from: announcement.status };
}

/* ── the fan-out ─────────────────────────────────────────────────── */

/** SCHEDULED rows whose time has come become SENDING; returns how many moved. */
export async function promoteDue(now = new Date()): Promise<number> {
  const due = await repository.findDue(now);
  let moved = 0;
  for (const row of due) {
    if (await repository.transition(row.id, ['SCHEDULED'], 'SENDING')) moved += 1;
  }
  return moved;
}

async function fanOutTo(announcement: Announcement, member: AudienceMember, already: Set<string>, now: Date): Promise<DeliveryMark[]> {
  const marks: DeliveryMark[] = [];
  const wantsInApp = !already.has(`${member.id}:IN_APP`);
  const outbound: NotificationChannel[] = [];
  if (announcement.channels.includes('EMAIL') && !already.has(`${member.id}:EMAIL`)) outbound.push('EMAIL');
  if (smsAllowed(announcement, now) && !already.has(`${member.id}:SMS`)) outbound.push('SMS');
  // G10: the phones, through the dispatcher's push rail; a member with no device is a skip the mark records.
  if (announcement.channels.includes('PUSH') && !already.has(`${member.id}:PUSH`)) outbound.push('PUSH');
  if (!wantsInApp && outbound.length === 0) return marks;

  const result = await notify(
    ANNOUNCEMENT_EVENT,
    member.id,
    { title: announcement.title, body: announcement.body, unsubscribeUrl: unsubscribeUrlFor(member.id) },
    {
      type: 'ANNOUNCEMENT',
      channels: outbound,
      ...(wantsInApp
        ? {
            inApp: {
              type: 'ANNOUNCEMENT' as const,
              title: announcement.title,
              message: announcement.body,
              ...(announcement.importance === 'CRITICAL' ? { subtitle: 'Service notice' } : {}),
              relatedId: announcement.id,
              // E9: the modal's facts, beside the prose.
              relatedType: 'ANNOUNCEMENT' as const,
              payload: { announcementId: announcement.id, importance: announcement.importance, title: announcement.title, body: announcement.body },
            },
          }
        : {}),
    },
  );

  if (wantsInApp) marks.push({ userId: member.id, channel: 'IN_APP', status: result.notificationId ? 'DELIVERED' : 'FAILED' });
  for (const channel of outbound) {
    const delivery = result.deliveries.find((d) => d.channel === channel);
    // Lot G (Q117): a row withheld by the weekly cap has an id and is still a skip; a quiet-hours deferral is queued.
    marks.push({ userId: member.id, channel, status: delivery?.deliveryId && !delivery.skipped ? 'QUEUED' : 'SKIPPED' });
  }
  return marks;
}

/**
 * One SENDING announcement, batch by batch, until the audience is walked or
 * the desk cancels it. Every (person, channel) is marked once, so a rerun
 * after a crash picks up where it stopped.
 */
export async function runAnnouncement(id: string, now = new Date()): Promise<{ recipients: number; batches: number; cancelled: boolean }> {
  let announcement = await getAnnouncement(id);
  if (announcement.status !== 'SENDING') return { recipients: 0, batches: 0, cancelled: announcement.status === 'CANCELLED' };

  const counts = await repository.audienceCounts(announcement.audience, announcement.city);
  await repository.update(id, { recipientCount: counts.total });

  let afterId: string | null = null;
  let batches = 0;
  for (;;) {
    announcement = await getAnnouncement(id);
    if (announcement.status !== 'SENDING') {
      logger.info('Announcement fan-out stopped', { announcementId: id, status: announcement.status, batches });
      return { recipients: counts.total, batches, cancelled: true };
    }

    const members = await repository.audiencePage(announcement.audience, announcement.city, afterId, BATCH_SIZE);
    if (members.length === 0) break;
    batches += 1;

    const existing = await repository.existingMarks(id, members.map((m) => m.id));
    const already = new Set(existing.map((e) => `${e.userId}:${e.channel}`));
    const marks: DeliveryMark[] = [];
    for (const member of members) {
      try {
        marks.push(...(await fanOutTo(announcement, member, already, now)));
      } catch (err) {
        logger.warn('Announcement fan-out failed for one recipient', { announcementId: id, userId: member.id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    await repository.writeMarks(id, marks);
    afterId = members[members.length - 1]!.id;
  }

  const deliveredByChannel = await repository.markCounts(id);
  const finished = await repository.transition(id, ['SENDING'], 'SENT', { sentAt: now, deliveredByChannel, recipientCount: counts.total });
  if (finished) {
    await logActivity(announcement.createdById, 'ANNOUNCEMENT_SENT', {
      module: 'announcements',
      targetType: 'Announcement',
      targetId: id,
      metadata: { recipientCount: counts.total, deliveredByChannel, audience: announcement.audience, city: announcement.city, importance: announcement.importance, batches },
    });
  }
  return { recipients: counts.total, batches, cancelled: !finished };
}

/** The job's tick: promote what is due, then run everything SENDING. */
export async function sendDueAnnouncements(now = new Date()): Promise<{ promoted: number; ran: number }> {
  const promoted = await promoteDue(now);
  const sending = await repository.findSending();
  let ran = 0;
  for (const row of sending) {
    await runAnnouncement(row.id, now);
    ran += 1;
  }
  return { promoted, ran };
}
