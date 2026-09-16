import type { FieldVisit } from '../../shared/database';
import type { AdminVisitsQuery, MyVisitsQuery } from './visits.schema';

export type VisitsPage = { items: FieldVisit[]; total: number; counts: Record<string, number> };

export type NewVisit = {
  displayId: string | null;
  kind: string;
  status: string;
  agentId: string;
  leadId?: string | null;
  publisherId?: string | null;
  advertiserId?: string | null;
  businessName: string;
  locality?: string | null;
  city?: string | null;
  /** Lot X-B: the `City` row `city` denotes, stamped by the service through `pricing.withCityKey`; null for a typed town. */
  cityId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  offerExpiresAt?: Date | null;
  scheduledFor?: Date | null;
  campaignTag?: string | null;
  notes?: string | null;
  requestedByUserId?: string | null;
};

export type VisitPatch = Partial<{
  agentId: string;
  status: string;
  offerExpiresAt: Date | null;
  scheduledFor: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  declinedReason: string | null;
  earnedAmount: string | null;
  incentiveId: string | null;
  notes: string | null;
}>;

export interface VisitsRepository {
  create(data: NewVisit): Promise<FieldVisit>;
  findById(visitId: string): Promise<FieldVisit | null>;
  update(visitId: string, patch: VisitPatch): Promise<FieldVisit>;
  /** The agent's own, in one of the three windows. */
  findMine(agentId: string, query: MyVisitsQuery, day: { start: Date; end: Date }): Promise<VisitsPage>;
  /**
   * The dispatch board. Lot X-L: `?city=` arrives with the key the service
   * resolved it to — rows match by `cityId`, the spelling only for rows whose
   * key is null; a facet that resolves to no key matches only null-keyed rows.
   */
  findForAdmin(query: AdminVisitsQuery & { cityId?: string | null }, day: { start: Date; end: Date } | null): Promise<VisitsPage>;
  /** Everything the agent holds inside one window — the day view. */
  findInWindow(agentId: string, window: { start: Date; end: Date }): Promise<FieldVisit[]>;
  /**
   * Lot E (Q99): the agent's visits slotted inside a range, whatever their
   * status — the diary overlay draws a declined visit as declined rather
   * than pretending it was never booked. Unslotted requests have no day and
   * are left to the day view.
   */
  findScheduledInRange(agentId: string, window: { start: Date; end: Date }): Promise<FieldVisit[]>;
  /** REQUESTED past their window, for the sweep. */
  findExpiredOffers(closedBefore: Date, notBefore: Date): Promise<FieldVisit[]>;
  /** REQUESTED or SCHEDULED — what Lot A's STOP_OPEN_WORK takes off a suspended agent. */
  findOpenForAgent(agentId: string): Promise<FieldVisit[]>;
  /**
   * P-B: the visits made to one publisher — scheduled, in progress or
   * completed (a declined or expired offer never happened to them) — newest
   * first, for the party's activity feed.
   */
  findForPublisher(publisherId: string, limit: number): Promise<FieldVisit[]>;
  /**
   * Lot B (Q1): what came of a visit — package sales made on it (sent or
   * paid, not drafts or cancellations) and campaigns launched on it
   * (SCHEDULED onwards). Counted off the rows that carry `visitId`, so the
   * visit never keeps a second record of the work.
   */
  countOutcomes(visitId: string): Promise<{ sales: number; campaigns: number }>;
}
