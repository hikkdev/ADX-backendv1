import type { Announcement, AnnouncementAudience, AnnouncementStatus, DeliveryStatus, NotificationChannel } from '../../shared/database';
import type { ListQuery } from '../../shared/pagination';

/**
 * Persistence seam for announcements — Lot E (Q64/Q130).
 *
 * The audience reads are the one place this module looks past its own
 * tables: who is a publisher, an advertiser, an agent, in which city. Those
 * are `users`' and the profile modules' columns, read here the way
 * `admin-overview` reads across the ledger — read-only, one query, never
 * written — because an audience is a count and a page of ids, not something
 * four modules should each export a slice of.
 */

export const ANNOUNCEMENT_STATUSES = ['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED'] as const;
export const ANNOUNCEMENT_SORTS = ['newest', 'oldest'] as const;

export interface AudienceMember {
  id: string;
  email: string | null;
  mobile: string;
  emailUnsubscribedAt: Date | null;
}

export interface AudienceCounts {
  total: number;
  /** An email on file and no unsubscribe stamp. */
  withEmail: number;
  withMobile: number;
  /** G11-2: device tokens on file across the audience — what a PUSH would be sent to (a person with two phones counts twice). */
  devices: number;
}

export interface AnnouncementFilter {
  q?: string | undefined;
  status?: readonly AnnouncementStatus[] | undefined;
  audience?: AnnouncementAudience | undefined;
}

export interface NewAnnouncement {
  title: string;
  body: string;
  audience: AnnouncementAudience;
  city: string | null;
  channels: NotificationChannel[];
  importance: 'NORMAL' | 'CRITICAL';
  scheduledAt: Date | null;
  createdById: string;
}

export interface AnnouncementPatch {
  status?: AnnouncementStatus;
  scheduledAt?: Date | null;
  recipientCount?: number;
  deliveredByChannel?: Record<string, Record<string, number>>;
  sentAt?: Date | null;
}

export interface DeliveryMark {
  userId: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
}

export interface AnnouncementsRepository {
  create(data: NewAnnouncement): Promise<Announcement>;
  findById(id: string): Promise<Announcement | null>;
  list(filter: AnnouncementFilter, page: ListQuery): Promise<{ items: Announcement[]; total: number; counts: Record<string, number> }>;
  update(id: string, patch: AnnouncementPatch): Promise<Announcement>;
  /** Moves the announcement from `from` to `to` only if it is still in `from`; false when somebody moved it first. */
  transition(id: string, from: readonly AnnouncementStatus[], to: AnnouncementStatus, patch?: AnnouncementPatch): Promise<boolean>;
  /** SCHEDULED rows whose time has come. */
  findDue(now: Date): Promise<Announcement[]>;
  findSending(): Promise<Announcement[]>;

  audienceCounts(audience: AnnouncementAudience, city: string | null): Promise<AudienceCounts>;
  /** Members by id ascending, after `afterId`, at most `take`. */
  audiencePage(audience: AnnouncementAudience, city: string | null, afterId: string | null, take: number): Promise<AudienceMember[]>;

  existingMarks(announcementId: string, userIds: readonly string[]): Promise<{ userId: string; channel: NotificationChannel }[]>;
  /** Idempotent: a (user, channel) already marked is left as it was. */
  writeMarks(announcementId: string, marks: readonly DeliveryMark[]): Promise<number>;
  /** `{ EMAIL: { QUEUED: 12, SKIPPED: 3 }, ... }` */
  markCounts(announcementId: string): Promise<Record<string, Record<string, number>>>;
}
