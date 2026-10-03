import { Decimal, money, type Money } from '../../shared/money';
import { addDays, dayKey, parseDay, today } from './pricing';
import { prismaPromotionsRepository as repository } from './prisma-promotions.repository';
import type { AdBookingRow, BoostRow, StatRow } from './promotions.repository';
import type { PromotionEventInput } from './promotions.schema';

/**
 * LM-1 — what a paid placement bought: impressions and clicks per day.
 *
 * Clients send an impression when half the ad or the sponsored card has
 * been on screen for a second, at most once per page view per item, and a
 * click on the tap. Counted per (day, item, surface, kind); an event naming
 * something that is not running today is dropped — a script cannot inflate a
 * finished ad, or invent one.
 */

export type StatsView = { impressions: number; clicks: number; ctr: number; byDay: { date: string; impressions: number; clicks: number }[] };

const ratio = (clicks: number, impressions: number): number => (impressions > 0 ? Math.round((clicks / impressions) * 10_000) / 100 : 0);

export function foldStats(rows: readonly StatRow[]): StatsView {
  const byDay = new Map<string, { date: string; impressions: number; clicks: number }>();
  let impressions = 0;
  let clicks = 0;
  for (const row of rows) {
    const date = dayKey(row.date);
    const day = byDay.get(date) ?? { date, impressions: 0, clicks: 0 };
    if (row.kind === 'IMPRESSION') {
      day.impressions += row.count;
      impressions += row.count;
    } else {
      day.clicks += row.count;
      clicks += row.count;
    }
    byDay.set(date, day);
  }
  return { impressions, clicks, ctr: ratio(clicks, impressions), byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function statsForAd(adBookingId: string): Promise<StatsView> {
  return foldStats(await repository.statsFor({ adBookingId }));
}

export async function statsForBoost(boostId: string): Promise<StatsView> {
  return foldStats(await repository.statsFor({ boostId }));
}

/**
 * `POST /app/promotions/events` — up to fifty events, counted against today.
 * Answers how many were counted and how many dropped.
 */
export async function recordEvents(events: readonly PromotionEventInput[], now = new Date()): Promise<{ counted: number; dropped: number }> {
  const day = today(now);
  const [ads, boosts] = await Promise.all([
    repository.runningAdIds([...new Set(events.flatMap((event) => (event.adBookingId ? [event.adBookingId] : [])))], day),
    repository.runningBoostIds([...new Set(events.flatMap((event) => (event.boostId ? [event.boostId] : [])))], day),
  ]);
  const running = new Set([...ads, ...boosts]);
  // One write per (item, surface, kind), however many of the fifty repeat it.
  const grouped = new Map<string, { adBookingId: string | null; boostId: string | null; surface: string; kind: PromotionEventInput['kind']; count: number }>();
  let dropped = 0;
  for (const event of events) {
    const target = event.adBookingId ?? event.boostId!;
    if (!running.has(target)) {
      dropped += 1;
      continue;
    }
    const key = `${event.adBookingId ?? ''}|${event.boostId ?? ''}|${event.surface}|${event.kind}`;
    const entry = grouped.get(key) ?? { adBookingId: event.adBookingId ?? null, boostId: event.boostId ?? null, surface: event.surface, kind: event.kind, count: 0 };
    entry.count += 1;
    grouped.set(key, entry);
  }
  for (const entry of grouped.values()) await repository.addStat({ date: day, ...entry });
  return { counted: events.length - dropped, dropped };
}

/* ── The desk's numbers ───────────────────────────────────────────── */

export type AdminStats = {
  window: { from: string; to: string };
  totals: { impressions: number; clicks: number; ctr: number; adsRunning: number; boostsRunning: number };
  /** Placements paid for inside the window: what came in (ex GST, the GST, with it), less what was refunded. */
  revenue: { bookings: number; subtotal: Money; gstAmount: Money; total: Money; refunded: Money; net: Money };
  bySlot: { slotKey: string; label: string; bookings: number; revenue: Money; impressions: number; clicks: number; ctr: number }[];
  byPlacement: { placement: string; bookings: number; revenue: Money; impressions: number; clicks: number; ctr: number }[];
  topAds: { adBookingId: string; displayId: string | null; title: string; slotKey: string; status: string; impressions: number; clicks: number; ctr: number }[];
};

/** `GET /promotions/admin/stats?from&to` — the last thirty days when no window is named. */
export async function adminStats(fromText: string | undefined, toText: string | undefined, now = new Date()): Promise<AdminStats> {
  const to = toText ? parseDay(toText, 'to') : today(now);
  const from = fromText ? parseDay(fromText, 'from') : addDays(to, -29);
  const toEnd = new Date(addDays(to, 1).getTime() - 1);
  const [stats, paidAds, paidBoosts, runningAds, runningBoosts] = await Promise.all([
    repository.statsBetween(from, to),
    repository.adsWhere({ paidAt: { gte: from, lte: toEnd } }),
    repository.boostsWhere({ paidAt: { gte: from, lte: toEnd } }),
    repository.adsWhere({ status: 'LIVE' }),
    repository.boostsWhere({ status: 'LIVE' }),
  ]);

  const perItem = new Map<string, { impressions: number; clicks: number }>();
  let impressions = 0;
  let clicks = 0;
  for (const row of stats) {
    const key = row.adBookingId ? `ad:${row.adBookingId}` : `boost:${row.boostId}`;
    const entry = perItem.get(key) ?? { impressions: 0, clicks: 0 };
    if (row.kind === 'IMPRESSION') {
      entry.impressions += row.count;
      impressions += row.count;
    } else {
      entry.clicks += row.count;
      clicks += row.count;
    }
    perItem.set(key, entry);
  }

  const paid: (AdBookingRow | BoostRow)[] = [...paidAds, ...paidBoosts];
  const kept = paid.filter((row) => !row.refundedAt);
  const sum = (rows: readonly (AdBookingRow | BoostRow)[], pick: (row: AdBookingRow | BoostRow) => { toString(): string }) =>
    rows.reduce((total, row) => total.plus(new Decimal(pick(row).toString())), new Decimal(0));
  const refunded = sum(paid.filter((row) => row.refundedAt), (row) => row.total);

  const bySlot = new Map<string, AdminStats['bySlot'][number]>();
  for (const ad of paidAds) {
    const entry = bySlot.get(ad.slot.key) ?? { slotKey: ad.slot.key, label: ad.slot.label, bookings: 0, revenue: '0.00', impressions: 0, clicks: 0, ctr: 0 };
    entry.bookings += 1;
    if (!ad.refundedAt) entry.revenue = money(new Decimal(entry.revenue).plus(ad.subtotal));
    bySlot.set(ad.slot.key, entry);
  }
  const allAds = new Map([...paidAds, ...runningAds].map((ad) => [ad.id, ad]));
  for (const [key, counts] of perItem) {
    if (!key.startsWith('ad:')) continue;
    const ad = allAds.get(key.slice(3));
    if (!ad) continue;
    const entry = bySlot.get(ad.slot.key) ?? { slotKey: ad.slot.key, label: ad.slot.label, bookings: 0, revenue: '0.00', impressions: 0, clicks: 0, ctr: 0 };
    entry.impressions += counts.impressions;
    entry.clicks += counts.clicks;
    bySlot.set(ad.slot.key, entry);
  }
  for (const entry of bySlot.values()) entry.ctr = ratio(entry.clicks, entry.impressions);

  const byPlacement = new Map<string, AdminStats['byPlacement'][number]>();
  const allBoosts = new Map([...paidBoosts, ...runningBoosts].map((boost) => [boost.id, boost]));
  for (const boost of paidBoosts) {
    for (const placement of boost.placements) {
      const entry = byPlacement.get(placement) ?? { placement, bookings: 0, revenue: '0.00', impressions: 0, clicks: 0, ctr: 0 };
      entry.bookings += 1;
      // A boost on both placements is one payment; its revenue is split evenly between them for this view.
      if (!boost.refundedAt) entry.revenue = money(new Decimal(entry.revenue).plus(new Decimal(boost.subtotal.toString()).dividedBy(boost.placements.length)));
      byPlacement.set(placement, entry);
    }
  }
  for (const [key, counts] of perItem) {
    if (!key.startsWith('boost:')) continue;
    const boost = allBoosts.get(key.slice(6));
    for (const placement of boost?.placements ?? []) {
      const entry = byPlacement.get(placement) ?? { placement, bookings: 0, revenue: '0.00', impressions: 0, clicks: 0, ctr: 0 };
      entry.impressions += counts.impressions;
      entry.clicks += counts.clicks;
      byPlacement.set(placement, entry);
    }
  }
  for (const entry of byPlacement.values()) entry.ctr = ratio(entry.clicks, entry.impressions);

  const topAds = [...perItem.entries()]
    .filter(([key]) => key.startsWith('ad:') && allAds.has(key.slice(3)))
    .map(([key, counts]) => {
      const ad = allAds.get(key.slice(3))!;
      return { adBookingId: ad.id, displayId: ad.displayId, title: ad.title, slotKey: ad.slot.key, status: ad.status, impressions: counts.impressions, clicks: counts.clicks, ctr: ratio(counts.clicks, counts.impressions) };
    })
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks)
    .slice(0, 10);

  const subtotal = sum(kept, (row) => row.subtotal);
  const gstAmount = sum(kept, (row) => row.gstAmount);
  const total = sum(kept, (row) => row.total);
  return {
    window: { from: dayKey(from), to: dayKey(to) },
    totals: { impressions, clicks, ctr: ratio(clicks, impressions), adsRunning: runningAds.length, boostsRunning: runningBoosts.length },
    revenue: { bookings: kept.length, subtotal: money(subtotal), gstAmount: money(gstAmount), total: money(total), refunded: money(refunded), net: money(subtotal) },
    bySlot: [...bySlot.values()].sort((a, b) => b.bookings - a.bookings),
    byPlacement: [...byPlacement.values()],
    topAds,
  };
}
