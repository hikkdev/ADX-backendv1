import type { AdBooking, AdSlot, BoostPlacement, BoostPlacementConfig, ListingBoost, MediaAsset, Prisma, PromotionEventKind, PromotionStatus } from '../../shared/database';
import type { DatedHold } from './pricing';

/**
 * LM-1 — what `promotions` needs from storage, stated as a port.
 *
 * Its own tables (AdSlot, AdBooking, BoostPlacementConfig, ListingBoost,
 * PromotionStat) and the MediaAsset rows a buyer's artwork becomes; plus
 * three label reads (listing, advertiser, publisher) for the views and the
 * desk, which only ever select a name.
 */

export type AdSlotRow = AdSlot;
export type PlacementRow = BoostPlacementConfig;
export type AdBookingRow = AdBooking & { slot: AdSlot };
export type BoostRow = ListingBoost;
export type MediaRow = MediaAsset;

/** The statuses that hold capacity. A PENDING_PAYMENT holds for its hour; DRAFT, REJECTED, CANCELLED and ENDED hold nothing. */
export const HOLDING_STATUSES = ['PENDING_PAYMENT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE'] as const satisfies readonly PromotionStatus[];

export type NewAdBooking = {
  displayId: string;
  slotId: string;
  advertiserId: string;
  createdByUserId: string;
  title: string;
  headline: string | null;
  ctaLabel: string | null;
  targetUrl: string | null;
  cityIds: string[];
  startDate: Date;
  endDate: Date;
  days: number;
  ratePerDay: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  gstAmount: Prisma.Decimal;
  total: Prisma.Decimal;
};

export type AdPatch = Partial<Omit<AdBooking, 'id' | 'displayId' | 'advertiserId' | 'createdByUserId' | 'createdAt' | 'updatedAt'>>;

export type NewBoost = {
  displayId: string;
  listingId: string;
  publisherId: string;
  createdByUserId: string;
  placements: BoostPlacement[];
  cityId: string | null;
  city: string | null;
  category: string;
  startDate: Date;
  endDate: Date;
  days: number;
  subtotal: Prisma.Decimal;
  gstAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  status: PromotionStatus;
};

export type BoostPatch = Partial<Omit<ListingBoost, 'id' | 'displayId' | 'listingId' | 'publisherId' | 'createdByUserId' | 'createdAt' | 'updatedAt'>>;

/** Where a boost is counted: its placement, in one city and one category. */
export type BoostScope = { placement: BoostPlacement; cityId: string | null; city: string | null; category: string };

export type ListingLabel = { id: string; displayId: string | null; title: string; city: string | null; cityId: string | null; category: string; status: string; publisherId: string | null; rightsLapsedAt: Date | null };
export type PartyLabel = { id: string; name: string; displayId: string | null };
export type CityLabel = { id: string; slug: string; name: string };

export type StatRow = { adBookingId: string | null; boostId: string | null; date: Date; kind: PromotionEventKind; count: number };

export type AdminListFilter = { status?: readonly string[] | undefined; q?: string | undefined; sort: string; page: number; pageSize: number };

export interface PromotionsRepository {
  // Slots
  listSlots(activeOnly: boolean): Promise<AdSlotRow[]>;
  findSlotByKey(key: string): Promise<AdSlotRow | null>;
  findSlot(idOrKey: string): Promise<AdSlotRow | null>;
  createSlot(data: Prisma.AdSlotCreateInput): Promise<AdSlotRow>;
  updateSlot(id: string, patch: Prisma.AdSlotUpdateInput): Promise<AdSlotRow>;

  // Placements
  listPlacements(): Promise<PlacementRow[]>;
  findPlacement(placement: BoostPlacement): Promise<PlacementRow | null>;
  updatePlacement(placement: BoostPlacement, patch: Prisma.BoostPlacementConfigUpdateInput): Promise<PlacementRow>;

  // Ads
  createAd(data: NewAdBooking): Promise<AdBookingRow>;
  findAd(id: string): Promise<AdBookingRow | null>;
  updateAd(id: string, patch: AdPatch): Promise<AdBookingRow>;
  /** Moves the booking only while it is still in one of `from` — the guard two racing requests (or a request and the job) meet. Answers whether it moved. */
  transitionAd(id: string, from: readonly PromotionStatus[], patch: AdPatch): Promise<boolean>;
  adHolds(slotId: string, from: Date, to: Date, excludeId?: string): Promise<DatedHold[]>;
  listAdsForAdvertiser(advertiserId: string, statuses?: readonly PromotionStatus[]): Promise<AdBookingRow[]>;
  listAdsPage(filter: AdminListFilter & { slotKey?: string | undefined }): Promise<{ items: AdBookingRow[]; total: number; counts: Record<string, number> }>;
  adsWhere(where: Prisma.AdBookingWhereInput): Promise<AdBookingRow[]>;
  /** The LIVE (or SCHEDULED, started) ads for a slot on the day, with their artwork. */
  runningAdsForSlot(slotKey: string, day: Date): Promise<(AdBookingRow & { media: MediaRow | null })[]>;

  // Boosts
  createBoost(data: NewBoost): Promise<BoostRow>;
  findBoost(id: string): Promise<BoostRow | null>;
  updateBoost(id: string, patch: BoostPatch): Promise<BoostRow>;
  transitionBoost(id: string, from: readonly PromotionStatus[], patch: BoostPatch): Promise<boolean>;
  boostHolds(scope: BoostScope, from: Date, to: Date, excludeId?: string): Promise<DatedHold[]>;
  listBoostsForPublisher(publisherId: string, statuses?: readonly PromotionStatus[]): Promise<BoostRow[]>;
  listBoostsPage(filter: AdminListFilter & { placement?: BoostPlacement | undefined }): Promise<{ items: BoostRow[]; total: number; counts: Record<string, number> }>;
  boostsWhere(where: Prisma.ListingBoostWhereInput): Promise<BoostRow[]>;
  runningBoosts(placement: BoostPlacement, day: Date): Promise<{ id: string; listingId: string }[]>;

  // Media
  findMedia(id: string): Promise<MediaRow | null>;
  findMediaMany(ids: string[]): Promise<MediaRow[]>;
  createMedia(data: Prisma.MediaAssetUncheckedCreateInput): Promise<MediaRow>;
  archiveMedia(id: string, at: Date): Promise<void>;

  // Stats
  addStat(input: { date: Date; adBookingId: string | null; boostId: string | null; surface: string; kind: PromotionEventKind; count: number }): Promise<void>;
  statsFor(target: { adBookingId?: string; boostId?: string }): Promise<StatRow[]>;
  statsBetween(from: Date, to: Date): Promise<StatRow[]>;
  /** Of these ids, the ones that are running on the day — the only ones an event may count against. */
  runningAdIds(ids: string[], day: Date): Promise<string[]>;
  runningBoostIds(ids: string[], day: Date): Promise<string[]>;

  // Labels
  listingLabels(ids: string[]): Promise<ListingLabel[]>;
  advertiserLabels(ids: string[]): Promise<PartyLabel[]>;
  publisherLabels(ids: string[]): Promise<PartyLabel[]>;
  /** Catalogue cities by id or by slug — how an ad's targeting is normalised and shown. */
  cityLabels(keys: string[]): Promise<CityLabel[]>;
}
