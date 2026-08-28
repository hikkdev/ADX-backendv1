import type { Listing, ListingCategory, ListingStatus } from '../../shared/database';

export type NewListing = {
  publisherId: string;
  agentId: string;
  title: string;
  category: ListingCategory;
  subType?: string;
  description?: string;
  address: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  size?: string;
  monthlyPrice: number;
  pricingModel?: string;
  availableNow?: boolean;
  photos?: { url: string; type: string }[];
  planId?: string;
};

export type ListingPatch = Partial<{
  title: string;
  description: string;
  monthlyPrice: number;
  availableNow: boolean;
  status: ListingStatus;
}>;

export interface ListingsRepository {
  create(data: NewListing): Promise<Listing>;
  findForPublisher(publisherId: string): Promise<Listing[]>;
  findAllForAdmin(): Promise<Listing[]>;
  findById(listingId: string): Promise<Listing | null>;
  update(listingId: string, data: ListingPatch): Promise<Listing>;
  publish(listingId: string): Promise<Listing>;
  /** Comparable active listings: same city and category, price within ±30%. */
  findSimilar(listing: Listing): Promise<Listing[]>;
  agentExists(agentId: string): Promise<boolean>;
}
