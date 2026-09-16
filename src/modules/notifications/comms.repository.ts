import type {
  DeliveryAttempt,
  DeliveryStatus,
  NotificationChannel,
  NotificationDelivery,
  NotificationTemplate,
  Prisma,
  TemplateStatus,
} from '../../shared/database';
import type { ListQuery } from '../../shared/pagination';
import type { TemplateSeed } from './templates';

/**
 * Persistence seam for the comms half of the module — Lot E (Q87): the
 * templates, the delivery log, and the two reads on `User` the dispatcher
 * needs (the address to send to, and the unsubscribe stamp).
 */

export const TEMPLATE_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export const TEMPLATE_SORTS = ['key', 'newest'] as const;
export const DELIVERY_STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED'] as const;
export const DELIVERY_SORTS = ['newest', 'oldest'] as const;

/** How many times the sender tries a row before it is FAILED. */
export const MAX_DELIVERY_ATTEMPTS = 3;

export interface Recipient {
  id: string;
  email: string | null;
  mobile: string;
  emailUnsubscribedAt: Date | null;
  isActive: boolean;
  closedAt: Date | null;
}

export interface TemplateFilter {
  q?: string | undefined;
  status?: readonly TemplateStatus[] | undefined;
  event?: string | undefined;
}

export interface TemplateInput {
  key: string;
  event: string;
  channels: NotificationChannel[];
  subject?: string | null;
  emailBody?: string | null;
  smsKind?: string | null;
  smsBody?: string | null;
  isSensitive?: boolean;
  /** Lot G (Q117): false for copy the quiet hours and the weekly cap govern — announcements, statements. */
  transactional?: boolean;
  /** G10 (Q103): the push title and body, rendered ahead of subject / smsBody when set. */
  pushTitle?: string | null;
  pushBody?: string | null;
  status?: TemplateStatus;
  updatedById?: string | null;
}

export interface DeliveryFilter {
  channel?: NotificationChannel | undefined;
  status?: readonly DeliveryStatus[] | undefined;
  templateKey?: string | undefined;
  /** Contains on the masked recipient. */
  maskedContains?: string | undefined;
  /** Exact match on the hash of an address. */
  recipientHash?: string | undefined;
  userId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export interface NewDelivery {
  userId: string | null;
  notificationId: string | null;
  templateKey: string;
  channel: NotificationChannel;
  recipientMasked: string;
  recipientHash: string;
  variables: Prisma.InputJsonValue | null;
  /** Lot G (Q117): a row born SKIPPED (the weekly cap). */
  status?: DeliveryStatus;
  lastError?: string | null;
  /** Lot G (Q117) / G10: a quiet-hours deferral — QUEUED, and not picked before this instant. */
  scheduledFor?: Date | null;
}

/** Lot G (Q121): one row per try — the rail's own words, masked, beside the outcome. */
export interface NewAttempt {
  deliveryId: string;
  attempt: number;
  provider: string | null;
  providerMessageId: string | null;
  ok: boolean;
  responseText: string | null;
  error: string | null;
}

/** Lot G (Q117): whose deliveries the weekly cap counts — the person, or the address when there is no login. */
export type CapSubject = { userId: string } | { recipientHash: string };

export interface DeliveryPatch {
  status?: DeliveryStatus;
  attempts?: number;
  provider?: string | null;
  providerMessageId?: string | null;
  lastError?: string | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  /** G10: set by the legacy fold only; the sender never moves a deferral. */
  scheduledFor?: Date | null;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  counts: Record<string, number>;
}

/** E10-2: the delivery log's page carries a channel histogram beside the status one, each counted with its own facet removed. */
export interface DeliveryListResult extends ListResult<NotificationDelivery> {
  byChannel: Record<string, number>;
}

/** E10-2: one template's outcomes over a window — the rows the sender attempted, by status. */
export interface TemplateStatRow {
  templateKey: string;
  status: DeliveryStatus;
  count: number;
}

/** Where the last slice of the export ended: the keyset the next one continues from. */
export interface DeliveryCursor {
  createdAt: Date;
  id: string;
}

/**
 * E10-2: a slice of the log for the export — the same filter, no count, no
 * histogram. E12-B: walked by keyset, not offset — the order is fixed as
 * (createdAt, id), both descending for `newest` and ascending for `oldest`,
 * and `after` is the last row of the slice before, so a row inserted while
 * the file streams can neither shift a row into the next slice twice nor
 * out of it altogether.
 */
export interface DeliverySlice {
  take: number;
  sort: 'newest' | 'oldest';
  after?: DeliveryCursor;
}

export interface CommsRepository {
  /** Writes the rows whose keys are missing; touches nothing that exists. Returns how many it wrote. */
  ensureTemplates(seeds: readonly TemplateSeed[]): Promise<number>;
  findActiveTemplate(event: string): Promise<NotificationTemplate | null>;
  findTemplateByKey(key: string): Promise<NotificationTemplate | null>;
  listTemplates(filter: TemplateFilter, page: ListQuery): Promise<ListResult<NotificationTemplate>>;
  createTemplate(data: TemplateInput): Promise<NotificationTemplate>;
  /** Bumps `version` by one on every edit. */
  updateTemplate(key: string, data: Partial<TemplateInput>): Promise<NotificationTemplate>;
  sensitiveTemplateKeys(): Promise<string[]>;
  /** Lot G (Q117): the keys whose copy the quiet hours and the weekly cap govern. */
  nonTransactionalTemplateKeys(): Promise<string[]>;
  /**
   * Lot G (Q117): a seeded row nobody has edited (`version` 1) takes the
   * seed's `transactional` flag — the column arrived defaulting to true on
   * every row, and the announcement and the statement are not. Returns how
   * many rows moved.
   */
  ensureTransactionalFlags(seeds: readonly { key: string; transactional: boolean }[]): Promise<number>;
  /** E10-2: every template, key / event / status / channels — the events catalogue names which copy answers each event. */
  allTemplates(): Promise<Pick<NotificationTemplate, 'key' | 'event' | 'status' | 'channels'>[]>;
  /** E10-2: one grouped query — deliveries created at or after `since`, counted by template key and status. */
  templateStats(since: Date): Promise<TemplateStatRow[]>;

  findRecipient(userId: string): Promise<Recipient | null>;
  markEmailUnsubscribed(userId: string, at: Date): Promise<boolean>;

  createDelivery(data: NewDelivery): Promise<NotificationDelivery>;
  findDelivery(id: string): Promise<NotificationDelivery | null>;
  listDeliveries(filter: DeliveryFilter, page: ListQuery): Promise<DeliveryListResult>;
  /** E10-2: one slice of the same query for the export, oldest or newest first. */
  findDeliveryRows(filter: DeliveryFilter, slice: DeliverySlice): Promise<NotificationDelivery[]>;
  /**
   * QUEUED rows under the attempt cap, oldest first, whose `scheduledFor` is
   * null or has passed at `now` — a quiet-hours deferral (Lot G, Q117) waits
   * on the column, not on a release step.
   */
  findQueued(limit: number, now: Date): Promise<NotificationDelivery[]>;
  /**
   * G10, one release: QUEUED rows written before the column, still carrying
   * the `QUIET_HOURS until` marker in `lastError` and no `scheduledFor`,
   * oldest first, for the fold.
   */
  findLegacyDeferred(limit: number): Promise<NotificationDelivery[]>;
  /**
   * Lot G (Q117): rows created in `[from, to)` for the subject under these
   * template keys, every status but SKIPPED — what the weekly cap counts.
   */
  countDeliveriesInWindow(subject: CapSubject, from: Date, to: Date, templateKeys: readonly string[]): Promise<number>;
  updateDelivery(id: string, patch: DeliveryPatch): Promise<NotificationDelivery>;
  /** Lot G (Q121): one row per try; `(deliveryId, attempt)` is unique. */
  recordAttempt(data: NewAttempt): Promise<DeliveryAttempt>;
  findAttempts(deliveryId: string): Promise<DeliveryAttempt[]>;
  findByProviderMessageId(provider: string, providerMessageId: string): Promise<NotificationDelivery | null>;
  /** Nulls `variables` on rows created before `before` (optionally only for these template keys). */
  purgeVariables(before: Date, at: Date, templateKeys?: readonly string[]): Promise<number>;
  deleteCreatedBefore(before: Date): Promise<number>;
}
