import type { Lead, LeadActivity } from '../../shared/database';
import type { AdminLeadsQuery, NearLeadsQuery } from './leads.schema';

/** A lead with the activity the detail screen draws under it. */
export type LeadWithActivity = Lead & { activity: LeadActivity[] };

export type LeadsPage = {
  items: Lead[];
  total: number;
  counts: Record<string, number>;
};

/**
 * A bubble on the agent's map — the "5 LEADS" chips DR 01 and DR 05 draw.
 *
 * Exactly the shape `agents.LeadCluster` already declares, so the layer that
 * has been rendering an empty array since the dashboard was built needs no
 * change at all beyond being given something.
 */
export type LeadCluster = {
  latitude: number;
  longitude: number;
  count: number;
  label: string;
};

/**
 * Where to look for bubbles.
 *
 * A point when the app has told us where the agent is, which is the honest
 * answer to "near you"; their city when it has not, because a dashboard that
 * shows nothing until location permission is granted teaches people the
 * feature is broken.
 */
export type LeadClusterScope =
  | { point: { latitude: number; longitude: number; radiusKm: number }; city?: undefined; cityId?: undefined }
  | {
      point?: undefined;
      city: string;
      /**
       * Lot X-L: the key `city` resolved to (`leadClusters` stamps it). Set,
       * the bubbles cover the leads keyed to the city plus the null-keyed
       * ones typed under this spelling — one hunting map, not one per
       * spelling. Null or absent: the spelling alone.
       */
      cityId?: string | null;
    };

export type NewLead = {
  side: string;
  businessName: string;
  displayId: string | null;
  category?: string | null;
  contactName?: string | null;
  phone?: string | null;
  /** Lot D (Q93): E.164, the hard duplicate key. Null when no phone, or not a phone. */
  phoneNormalised?: string | null;
  email?: string | null;
  address?: string | null;
  locality?: string | null;
  city?: string | null;
  /** Lot X-B: the `City` row `city` denotes, stamped by the service through `pricing.withCityKey`; null for a typed town. */
  cityId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  interest?: string | null;
  source?: string | null;
  bestTimeFrom?: string | null;
  bestTimeTo?: string | null;
  estimatedCommission?: string | null;
  assignedAgentId?: string | null;
  createdByUserId?: string | null;
};

export type LeadPatch = Partial<Omit<NewLead, 'displayId'>> & {
  status?: string;
  firstContactedAt?: Date | null;
  convertedPublisherId?: string | null;
  convertedAdvertiserId?: string | null;
  convertedAt?: Date | null;
};

export interface LeadsRepository {
  create(data: NewLead): Promise<Lead>;
  createMany(rows: NewLead[]): Promise<number>;
  findById(leadId: string): Promise<LeadWithActivity | null>;
  update(leadId: string, patch: LeadPatch): Promise<Lead>;

  /** The agent's list. Ranked by distance when a point is given. */
  findNear(query: NearLeadsQuery): Promise<LeadsPage>;
  /** The ops desk. Lot X-B: `cityId` is the key `query.city` resolved to — rows match on it, or on the spelling for the rows whose key is null. */
  findForAdmin(query: AdminLeadsQuery & { cityId?: string | null }): Promise<LeadsPage>;

  /**
   * The map layer: open leads grouped by the locality they sit in.
   *
   * Grouped in the database rather than in the service, because the point of a
   * cluster is not to send a thousand rows to a phone and count them there.
   */
  clustersNear(where: LeadClusterScope): Promise<LeadCluster[]>;

  logActivity(entry: {
    leadId: string;
    actorUserId: string | null;
    kind: string;
    note?: string | null;
  }): Promise<LeadActivity>;

  /* ── Lot D (Q93): dedup ─────────────────────────────────────────── */

  /** Leads already carrying any of these normalised numbers. */
  findByPhones(phones: string[]): Promise<{ id: string; displayId: string | null; phoneNormalised: string | null }[]>;
  /**
   * Publisher and advertiser accounts on any of these numbers. Read here
   * rather than through those modules because neither exports a lookup by
   * mobile, and a read is not a decision — the same call `disputes` makes
   * for an order's parties.
   */
  findAccountsByPhones(phones: string[]): Promise<AccountByPhone[]>;
  /** Existing leads whose business name matches any of these, case-insensitively; the service folds the city. */
  findByNameAndCity(names: string[]): Promise<{ id: string; displayId: string | null; businessName: string; city: string | null }[]>;
  /**
   * The import, written whole in one transaction: every lead with its
   * IMPORTED activity, or none of them. Ids and numbers are minted by the
   * caller before this runs.
   */
  importBatch(rows: (NewLead & { displayId: string })[]): Promise<{ id: string; displayId: string | null }[]>;

  /**
   * Lot V: every open lead (not CONVERTED, not LOST) whose city is one of
   * these spellings, case-insensitively, set LOST in one transaction with a
   * STATUS_CHANGED activity each carrying `note`. Answers the ids closed;
   * a second call finds none. Lot X-B: `cityId` first — a row keyed to the
   * city is found whatever it was typed as; the spellings catch the rows
   * whose key is null.
   */
  closeOpenLeadsInCities(city: { cityId: string | null; spellings: string[] }, actorUserId: string | null, note: string): Promise<string[]>;
}

export type AccountByPhone = { phoneNormalised: string; kind: 'PUBLISHER' | 'ADVERTISER'; id: string };
