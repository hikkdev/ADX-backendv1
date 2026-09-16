import { money, type Money } from '../../../shared/money';
import { toListPage } from '../../../shared/pagination';
import { prismaPublisherBookRepository as repository, type BookPublisher, type PublisherFacts } from './prisma-publisher-book.repository';
import type { PublisherBookQuery } from './publisher-book.schema';

/**
 * The agent's publisher book (DR 06 `4420:591`): "18 Publishers", a card per
 * account with its listing count and revenue to date.
 *
 * Revenue is the sum of the publisher's net accruals — what they have actually
 * earned — and it is SUPPRESSED (null, not zero) while KYC is pending: a figure
 * on an account that cannot be paid yet is a promise. The frame's category chip
 * ("PRINT VENDOR", "GYM") has no source — a publisher has no category — so the
 * card carries the categories of their listings instead, which is the one thing
 * that is true about what they let out.
 */
export type PublisherBookRow = {
  id: string;
  displayId: string | null;
  name: string;
  phone: string;
  city: string | null;
  address: string | null;
  kycStatus: string;
  onboardingStatus: string;
  active: boolean;
  categories: string[];
  listings: number;
  /** "12 Bookings" on the detail: orders on their listings that were not abandoned as drafts. */
  bookings: number;
  /** Net earnings to date, as money — null while KYC is pending. */
  revenueToDate: Money | null;
};

function toRow(publisher: BookPublisher, facts: PublisherFacts | undefined): PublisherBookRow {
  const active = publisher.onboardingStatus === 'ONBOARDING_COMPLETE' && publisher.kycStatus === 'VERIFIED';
  return {
    id: publisher.id,
    displayId: publisher.displayId,
    name: publisher.name,
    phone: publisher.mobile,
    city: publisher.city,
    address: publisher.address,
    kycStatus: publisher.kycStatus,
    onboardingStatus: publisher.onboardingStatus,
    active,
    categories: facts?.categories ?? [],
    listings: facts?.listings ?? 0,
    bookings: facts?.bookings ?? 0,
    revenueToDate: publisher.kycStatus === 'VERIFIED' ? money(facts?.revenue ?? 0) : null,
  };
}

export async function publisherBook(agentId: string, query: PublisherBookQuery) {
  const { items, total, counts } = await repository.findBook(agentId, query);
  const facts = await repository.facts(items.map((publisher) => publisher.id));
  let rows = items.map((publisher) => toRow(publisher, facts.get(publisher.id)));
  if (query.sort === 'REVENUE_DESC') {
    rows = [...rows].sort((a, b) => Number(b.revenueToDate ?? -1) - Number(a.revenueToDate ?? -1) || a.name.localeCompare(b.name));
  }
  return toListPage(rows, total, counts, query);
}
