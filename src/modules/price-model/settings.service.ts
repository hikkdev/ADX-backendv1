import { Decimal } from '../../shared/money';
import { prismaPriceModelRepository as repository } from './prisma-price-model.repository';

/**
 * The General tab of the pricing model.
 *
 * Rate basis, duration discounts and guardrails: the dials an operator turns
 * that are not a multiplier on any one property of a spot. One row, read on
 * every quote, defaulted so a deployment that has never opened the tab still
 * behaves.
 */

export type DurationTier = { minDays: number; pct: number };

export type PriceModelSettings = {
  roundingRupees: number;
  minimumRatePerDay: string;
  minimumBookingDays: number;
  floorProtection: boolean;
  /** Ascending by `minDays`. The last tier whose threshold the flight reaches wins. */
  durationDiscounts: DurationTier[];
  approvalThresholdPct: string;
  discountCeilingPct: string;
  maxStackedUplift: string;
  blockBelowFloor: boolean;
};

export type PriceModelSettingsPatch = Partial<PriceModelSettings>;

const DEFAULT_TIERS: DurationTier[] = [
  { minDays: 14, pct: 2 },
  { minDays: 28, pct: 4 },
  { minDays: 56, pct: 7 },
  { minDays: 84, pct: 10 },
];

function shape(row: Awaited<ReturnType<typeof repository.getSettings>>): PriceModelSettings {
  const tiers = Array.isArray(row?.durationDiscounts) ? (row!.durationDiscounts as DurationTier[]) : [];
  return {
    roundingRupees: row?.roundingRupees ?? 100,
    minimumRatePerDay: new Decimal(row?.minimumRatePerDay ?? 0).toFixed(2),
    minimumBookingDays: row?.minimumBookingDays ?? 7,
    floorProtection: row?.floorProtection ?? true,
    // The frame draws four tiers. A fresh deployment gets them rather than an
    // empty ladder, because an empty ladder looks like a broken screen.
    durationDiscounts: tiers.length > 0 ? tiers : DEFAULT_TIERS,
    approvalThresholdPct: new Decimal(row?.approvalThresholdPct ?? 10).toFixed(2),
    discountCeilingPct: new Decimal(row?.discountCeilingPct ?? 15).toFixed(2),
    maxStackedUplift: new Decimal(row?.maxStackedUplift ?? 2.2).toFixed(4),
    blockBelowFloor: row?.blockBelowFloor ?? true,
  };
}

export async function getSettings(): Promise<PriceModelSettings> {
  return shape(await repository.getSettings());
}

export async function updateSettings(
  patch: PriceModelSettingsPatch,
  updatedById: string
): Promise<PriceModelSettings> {
  const tiers = patch.durationDiscounts
    ? [...patch.durationDiscounts].sort((a, b) => a.minDays - b.minDays)
    : undefined;

  const row = await repository.upsertSettings({
    ...(patch.roundingRupees !== undefined ? { roundingRupees: patch.roundingRupees } : {}),
    ...(patch.minimumRatePerDay !== undefined
      ? { minimumRatePerDay: new Decimal(patch.minimumRatePerDay) }
      : {}),
    ...(patch.minimumBookingDays !== undefined
      ? { minimumBookingDays: patch.minimumBookingDays }
      : {}),
    ...(patch.floorProtection !== undefined ? { floorProtection: patch.floorProtection } : {}),
    ...(tiers ? { durationDiscounts: tiers } : {}),
    ...(patch.approvalThresholdPct !== undefined
      ? { approvalThresholdPct: new Decimal(patch.approvalThresholdPct) }
      : {}),
    ...(patch.discountCeilingPct !== undefined
      ? { discountCeilingPct: new Decimal(patch.discountCeilingPct) }
      : {}),
    ...(patch.maxStackedUplift !== undefined
      ? { maxStackedUplift: new Decimal(patch.maxStackedUplift) }
      : {}),
    ...(patch.blockBelowFloor !== undefined ? { blockBelowFloor: patch.blockBelowFloor } : {}),
    updatedById,
  });
  return shape(row);
}

/** The discount a flight of this length earns, as a percentage. Zero if none. */
export function durationDiscountFor(days: number, tiers: DurationTier[]): DurationTier | null {
  let matched: DurationTier | null = null;
  for (const tier of [...tiers].sort((a, b) => a.minDays - b.minDays)) {
    if (days >= tier.minDays) matched = tier;
  }
  return matched;
}
