import type { AccountActivity, AccountActivityKind, Brand, CampaignStatus } from '../../../shared/database';
import type { Decimal } from '../../../shared/money';
import type { AdvertiserBookQuery } from './book.schema';

/** One account on the agent's book, before the aggregates. */
export type BookAccount = {
  id: string;
  displayId: string | null;
  name: string;
  companyName: string | null;
  mobile: string;
  city: string | null;
  kycStatus: string;
  activatedAt: Date | null;
  createdAt: Date;
};

/** What the campaigns say about one account, in one pass. */
export type CampaignFacts = {
  total: number;
  live: number;
  /** Committed budget across every non-draft campaign, as Decimal. */
  spend: Decimal;
  lastCreatedAt: Date | null;
  /** The newest campaign's industry — the "QSR" chip the card draws. */
  industry: string | null;
  /** Likewise its sub-category — the "COFFEE" tag on the detail. */
  subCategory: string | null;
};

export type OpenVisit = { id: string; advertiserId: string; status: string; scheduledFor: Date | null };

export type CampaignLine = {
  id: string;
  name: string;
  status: CampaignStatus;
  budget: Decimal | null;
  startDate: Date | null;
  endDate: Date | null;
  spots: number;
  brandId: string | null;
  awareness: string | null;
  industry: string | null;
  createdAt: Date;
};

export type FeedEvent = { kind: 'ACTIVITY' | 'FIELD_VISIT' | 'CAMPAIGN_LIVE' | 'PACKAGE_PAID'; at: Date; title: string; detail: string | null };

export type BrandCounts = { campaigns: number; live: number; scheduled: number; spend: Decimal; awareness: string | null; industry: string | null; subCategory: string | null };

export interface BookRepository {
  /** The page of accounts this agent looks after, with the histogram over the search but not the chip. */
  findBook(agentId: string, query: AdvertiserBookQuery): Promise<{ items: BookAccount[]; total: number; counts: Record<string, number> }>;
  campaignFacts(advertiserIds: string[]): Promise<Map<string, CampaignFacts>>;
  openVisits(advertiserIds: string[]): Promise<Map<string, OpenVisit>>;

  /* The detail card. */
  findAccount(advertiserId: string): Promise<BookAccount | null>;
  campaignsOf(advertiserId: string): Promise<CampaignLine[]>;
  spotsOf(advertiserId: string): Promise<number>;
  feedOf(advertiserId: string, limit: number): Promise<FeedEvent[]>;

  /* The action log. */
  createActivity(data: { advertiserId: string; agentId: string; kind: AccountActivityKind; note: string | null; createdByUserId: string; at: Date }): Promise<AccountActivity>;
  listActivity(advertiserId: string, limit: number): Promise<AccountActivity[]>;

  /* Brands with their numbers. */
  brandsOf(advertiserId: string, status: 'ACTIVE' | 'ARCHIVED' | undefined): Promise<Brand[]>;
  findBrand(advertiserId: string, brandId: string): Promise<Brand | null>;
  brandCounts(brandIds: string[]): Promise<Map<string, BrandCounts>>;
  campaignsOfBrand(brandId: string): Promise<CampaignLine[]>;
}
