import type { AccountActivity, Brand } from '../../../shared/database';
import { ApiError } from '../../../shared/errors';
import { money, type Money } from '../../../shared/money';
import { toListPage } from '../../../shared/pagination';
import { prismaBookRepository as repository } from './prisma-book.repository';
import type { BookAccount, CampaignFacts, CampaignLine, OpenVisit } from './book.repository';
import { DORMANT_AFTER_DAYS, type AccountActivityInput, type AdvertiserBookQuery } from './book.schema';

/**
 * The agent's advertiser book (DR 06 `4420:699`), its detail card (`4432:145`)
 * and the brands behind it.
 *
 * Every figure on a card is read from rows that already exist — campaigns,
 * field visits, package sales — and every field the frame draws that has no
 * source is absent, not zero-filled. "QSR" is the newest campaign's industry
 * because an advertiser has no category of its own; "MG Road" is the account's
 * city because it has no locality.
 *
 * The per-row NEXT ACTION decides the footer: metrics for a healthy account, a
 * **Check in** for one with a visit on the calendar, a **Follow up** for one
 * that has gone quiet. Quiet is named once: no campaign created in
 * DORMANT_AFTER_DAYS.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type NextAction =
  | { kind: 'METRICS' }
  | { kind: 'CHECK_IN'; visitId: string; visitStatus: string; at: string | null }
  | { kind: 'FOLLOW_UP'; dormantDays: number; line: string };

export type AdvertiserBookRow = {
  id: string;
  displayId: string | null;
  name: string;
  industry: string | null;
  /** The newest campaign's sub-category — "COFFEE" beside "QSR" on the detail. */
  subCategory: string | null;
  city: string | null;
  phone: string;
  kycStatus: string;
  active: boolean;
  activatedAt: string | null;
  campaigns: { total: number; live: number };
  /** Committed budget across campaigns, as money. */
  spend: Money;
  lastCampaignAt: string | null;
  nextAction: NextAction;
};

/** Days since the newest campaign — or since the account was activated, or opened. */
function quietFor(account: BookAccount, facts: CampaignFacts | undefined, now: Date): number {
  const since = facts?.lastCreatedAt ?? account.activatedAt ?? account.createdAt;
  return Math.floor((now.getTime() - since.getTime()) / DAY_MS);
}

export function nextActionFor(account: BookAccount, facts: CampaignFacts | undefined, visit: OpenVisit | undefined, now: Date): NextAction {
  if (visit) {
    return { kind: 'CHECK_IN', visitId: visit.id, visitStatus: visit.status, at: visit.scheduledFor?.toISOString() ?? null };
  }
  const quiet = quietFor(account, facts, now);
  if (quiet >= DORMANT_AFTER_DAYS) {
    return {
      kind: 'FOLLOW_UP',
      dormantDays: quiet,
      line: facts?.total ? `No campaigns in ${quiet} days` : `No campaigns yet — ${quiet} days`,
    };
  }
  return { kind: 'METRICS' };
}

function toRow(account: BookAccount, facts: CampaignFacts | undefined, visit: OpenVisit | undefined, now: Date): AdvertiserBookRow {
  return {
    id: account.id,
    displayId: account.displayId,
    name: account.companyName ?? account.name,
    industry: facts?.industry ?? null,
    subCategory: facts?.subCategory ?? null,
    city: account.city,
    phone: account.mobile,
    kycStatus: account.kycStatus,
    active: account.activatedAt !== null,
    activatedAt: account.activatedAt?.toISOString() ?? null,
    campaigns: { total: facts?.total ?? 0, live: facts?.live ?? 0 },
    spend: money(facts?.spend ?? 0),
    lastCampaignAt: facts?.lastCreatedAt?.toISOString() ?? null,
    nextAction: nextActionFor(account, facts, visit, now),
  };
}

export async function advertiserBook(agentId: string, query: AdvertiserBookQuery, now = new Date()) {
  const { items, total, counts } = await repository.findBook(agentId, query);
  const ids = items.map((account) => account.id);
  const [facts, visits] = await Promise.all([repository.campaignFacts(ids), repository.openVisits(ids)]);
  let rows = items.map((account) => toRow(account, facts.get(account.id), visits.get(account.id), now));
  // Spend is an aggregate, so the sort by it happens here, over the page.
  if (query.sort === 'SPEND_DESC') rows = [...rows].sort((a, b) => Number(b.spend) - Number(a.spend) || a.name.localeCompare(b.name));
  return toListPage(rows, total, counts, query);
}

/* ─── The detail card ──────────────────────────────────────────────────── */

export type CampaignLineView = {
  id: string;
  name: string;
  status: string;
  budget: Money | null;
  spots: number;
  startDate: string | null;
  endDate: string | null;
  brandId: string | null;
};

const toLineView = (line: CampaignLine): CampaignLineView => ({
  id: line.id,
  name: line.name,
  status: line.status,
  budget: line.budget ? money(line.budget) : null,
  spots: line.spots,
  startDate: line.startDate?.toISOString() ?? null,
  endDate: line.endDate?.toISOString() ?? null,
  brandId: line.brandId,
});

export type AdvertiserSummary = {
  account: AdvertiserBookRow;
  metrics: { campaigns: number; spots: number; spend: Money };
  campaigns: CampaignLineView[];
  activity: { kind: string; at: string; title: string; detail: string | null }[];
};

export async function advertiserSummary(advertiserId: string, now = new Date()): Promise<AdvertiserSummary> {
  const account = await repository.findAccount(advertiserId);
  if (!account) throw new ApiError(404, 'NOT_FOUND', 'Advertiser not found');
  const [facts, visits, campaigns, spots, feed] = await Promise.all([
    repository.campaignFacts([advertiserId]),
    repository.openVisits([advertiserId]),
    repository.campaignsOf(advertiserId),
    repository.spotsOf(advertiserId),
    repository.feedOf(advertiserId, 30),
  ]);
  const row = toRow(account, facts.get(advertiserId), visits.get(advertiserId), now);
  return {
    account: row,
    metrics: { campaigns: row.campaigns.total, spots, spend: row.spend },
    campaigns: campaigns.map(toLineView),
    activity: feed.map((event) => ({ kind: event.kind, at: event.at.toISOString(), title: event.title, detail: event.detail })),
  };
}

/* ─── The action log (decision 14) ─────────────────────────────────────── */

export type AccountActivityView = { id: string; kind: string; note: string | null; at: string };

const toActivityView = (row: AccountActivity): AccountActivityView => ({ id: row.id, kind: row.kind, note: row.note ?? null, at: row.at.toISOString() });

export async function recordAccountActivity(
  advertiserId: string,
  agentId: string,
  input: AccountActivityInput,
  createdByUserId: string,
  now = new Date(),
): Promise<AccountActivityView> {
  const account = await repository.findAccount(advertiserId);
  if (!account) throw new ApiError(404, 'NOT_FOUND', 'Advertiser not found');
  const row = await repository.createActivity({ advertiserId, agentId, kind: input.kind, note: input.note ?? null, createdByUserId, at: now });
  return toActivityView(row);
}

export async function listAccountActivity(advertiserId: string): Promise<AccountActivityView[]> {
  return (await repository.listActivity(advertiserId, 100)).map(toActivityView);
}

/* ─── Brands (S8) ───────────────────────────────────────────────────────── */

export type BrandCard = {
  id: string;
  advertiserId: string;
  name: string;
  sector: string;
  logoUrl: string | null;
  website: string | null;
  isActive: boolean;
  archived: boolean;
  /** The newest campaign's awareness level — the Brand Details card's figure. */
  awareness: string | null;
  /** Likewise the newest campaign's industry and sub-category ("QSR" / "Coffee"); a brand has none of its own. */
  industry: string | null;
  subCategory: string | null;
  campaigns: { total: number; live: number; scheduled: number };
  /** Committed budget across the brand's campaigns, as money. */
  lifetimeSpend: Money;
  createdAt: string;
};

export async function brandCards(advertiserId: string, status?: 'ACTIVE' | 'ARCHIVED'): Promise<BrandCard[]> {
  const brands = await repository.brandsOf(advertiserId, status);
  const counts = await repository.brandCounts(brands.map((brand) => brand.id));
  return brands.map((brand) => toBrandCard(brand, counts.get(brand.id)));
}

function toBrandCard(
  brand: Brand,
  counts: { campaigns: number; live: number; scheduled: number; spend: unknown; awareness: string | null; industry: string | null; subCategory: string | null } | undefined,
): BrandCard {
  return {
    id: brand.id,
    advertiserId: brand.advertiserId,
    name: brand.name,
    sector: brand.sector,
    logoUrl: brand.logoUrl,
    website: brand.website,
    isActive: brand.isActive,
    archived: !brand.isActive,
    awareness: counts?.awareness ?? null,
    industry: counts?.industry ?? null,
    subCategory: counts?.subCategory ?? null,
    campaigns: { total: counts?.campaigns ?? 0, live: counts?.live ?? 0, scheduled: counts?.scheduled ?? 0 },
    lifetimeSpend: money((counts?.spend as never) ?? 0),
    createdAt: brand.createdAt.toISOString(),
  };
}

export async function brandDetail(advertiserId: string, brandId: string) {
  const brand = await repository.findBrand(advertiserId, brandId);
  if (!brand) throw new ApiError(404, 'NOT_FOUND', 'Brand not found');
  const [counts, campaigns] = await Promise.all([repository.brandCounts([brandId]), repository.campaignsOfBrand(brandId)]);
  return { ...toBrandCard(brand, counts.get(brandId)), campaignList: campaigns.map(toLineView) };
}
