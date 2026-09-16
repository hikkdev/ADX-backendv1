import type { Prisma, CategoryRuleEffect, PriceRuleAdjustment } from '../../shared/database';

/**
 * Storage for the manual pricing model.
 *
 * Three things ops sets by hand and one thing they produce with it: dimensions,
 * category rules, conditional rules, and the quote.
 */

/* ── Dimensions ──────────────────────────────────────────────────────── */

export type DimensionValueRow = {
  id: string;
  dimensionId: string;
  label: string;
  multiplier: Prisma.Decimal;
  minAreaSqFt: Prisma.Decimal | null;
  maxAreaSqFt: Prisma.Decimal | null;
  sortOrder: number;
  isActive: boolean;
};

export type DimensionRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  values: DimensionValueRow[];
};

export type NewDimension = {
  name: string;
  slug: string;
  description?: string | null;
  sortOrder?: number;
};

export type DimensionValueInput = {
  label: string;
  multiplier: Prisma.Decimal;
  minAreaSqFt?: Prisma.Decimal | null;
  maxAreaSqFt?: Prisma.Decimal | null;
  sortOrder?: number;
  isActive?: boolean;
};

/* ── Category rules ──────────────────────────────────────────────────── */

export type CategoryRuleRow = {
  id: string;
  sector: string;
  mediaTypeId: string | null;
  mediaTypeName?: string | null;
  effect: CategoryRuleEffect;
  multiplier: Prisma.Decimal | null;
  note: string | null;
  isActive: boolean;
};

export type NewCategoryRule = {
  sector: string;
  mediaTypeId?: string | null;
  effect: CategoryRuleEffect;
  multiplier?: Prisma.Decimal | null;
  note?: string | null;
};

/* ── Rules ───────────────────────────────────────────────────────────── */

export type RuleConditionRow = {
  id: string;
  field: string;
  operator: string;
  value: string;
};

export type PriceRuleRow = {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  matchAny: boolean;
  adjustment: PriceRuleAdjustment;
  value: Prisma.Decimal;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  conditions: RuleConditionRow[];
};

export type NewPriceRule = {
  name: string;
  description?: string | null;
  priority?: number;
  matchAny?: boolean;
  adjustment: PriceRuleAdjustment;
  value: Prisma.Decimal;
  startsAt?: Date | null;
  endsAt?: Date | null;
};

export type ConditionInput = { field: string; operator: string; value: string };

/* ── Quotes ──────────────────────────────────────────────────────────── */

export type QuoteLineRow = {
  id: string;
  listingId: string | null;
  mediaTypeId: string;
  mediaTypeName?: string;
  grade: string;
  cityId: string | null;
  label: string | null;
  quantity: number;
  days: number;
  rateCardId: string | null;
  cardRatePerDay: Prisma.Decimal | null;
  floorPerDay: Prisma.Decimal | null;
  ratePerDay: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  trace: unknown;
};

export type QuoteRow = {
  id: string;
  reference: string;
  status: string;
  advertiserId: string | null;
  advertiserName?: string | null;
  sector: string | null;
  notes: string | null;
  discountPct: Prisma.Decimal | null;
  subtotalPerDay: Prisma.Decimal;
  totalPerDay: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  belowFloor: boolean;
  createdById: string;
  createdAt: Date;
  expiresAt: Date | null;
  lines?: QuoteLineRow[];
};

export type NewQuote = {
  reference: string;
  advertiserId?: string | null;
  sector?: string | null;
  notes?: string | null;
  discountPct?: Prisma.Decimal | null;
  subtotalPerDay: Prisma.Decimal;
  totalPerDay: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  belowFloor: boolean;
  createdById: string;
  expiresAt?: Date | null;
  lines: Omit<QuoteLineRow, 'id' | 'mediaTypeName'>[];
};

export interface PriceModelRepository {
  listDimensions(includeInactive?: boolean): Promise<DimensionRow[]>;
  findDimension(id: string): Promise<DimensionRow | null>;
  createDimension(data: NewDimension): Promise<DimensionRow>;
  updateDimension(id: string, patch: Partial<NewDimension> & { isActive?: boolean }): Promise<DimensionRow>;
  deleteDimension(id: string): Promise<void>;
  replaceDimensionValues(dimensionId: string, values: DimensionValueInput[]): Promise<void>;

  listCategoryRules(): Promise<CategoryRuleRow[]>;
  createCategoryRule(data: NewCategoryRule): Promise<CategoryRuleRow>;
  updateCategoryRule(id: string, patch: Partial<NewCategoryRule> & { isActive?: boolean }): Promise<CategoryRuleRow>;
  deleteCategoryRule(id: string): Promise<void>;
  /** Most specific wins: a rule naming this media type beats the catch-all. */
  findCategoryRule(sector: string, mediaTypeId: string): Promise<CategoryRuleRow | null>;

  listRules(includeInactive?: boolean): Promise<PriceRuleRow[]>;
  findRule(id: string): Promise<PriceRuleRow | null>;
  createRule(data: NewPriceRule): Promise<PriceRuleRow>;
  updateRule(id: string, patch: Partial<NewPriceRule> & { isActive?: boolean }): Promise<PriceRuleRow>;
  deleteRule(id: string): Promise<void>;
  replaceConditions(ruleId: string, conditions: ConditionInput[]): Promise<void>;
  /** Active rules in force on a date, in firing order. */
  rulesInForce(on: Date): Promise<PriceRuleRow[]>;

  getSettings(): Promise<SettingsRow | null>;
  upsertSettings(patch: SettingsPatch): Promise<SettingsRow>;
  /** Everything the simulator reads off a site, in one row. */
  listingForSimulation(listingId: string): Promise<SimulationListing | null>;

  listQuotes(status?: string): Promise<QuoteRow[]>;
  findQuote(id: string): Promise<QuoteRow | null>;
  createQuote(data: NewQuote): Promise<QuoteRow>;
  setQuoteStatus(id: string, status: string): Promise<QuoteRow>;
  referenceExists(reference: string): Promise<boolean>;
}

/* ── Settings and the simulator's view of a listing ─────────────────── */

export type SettingsRow = {
  roundingRupees: number;
  minimumRatePerDay: Prisma.Decimal;
  minimumBookingDays: number;
  floorProtection: boolean;
  durationDiscounts: unknown;
  approvalThresholdPct: Prisma.Decimal;
  discountCeilingPct: Prisma.Decimal;
  maxStackedUplift: Prisma.Decimal;
  blockBelowFloor: boolean;
};

export type SettingsPatch = Partial<{
  roundingRupees: number;
  minimumRatePerDay: Prisma.Decimal;
  minimumBookingDays: number;
  floorProtection: boolean;
  durationDiscounts: unknown;
  approvalThresholdPct: Prisma.Decimal;
  discountCeilingPct: Prisma.Decimal;
  maxStackedUplift: Prisma.Decimal;
  blockBelowFloor: boolean;
}> & { updatedById: string };

export type SimulationListing = {
  id: string;
  title: string;
  city: string | null;
  cityId: string | null;
  latitude: number | null;
  longitude: number | null;
  mediaTypeId: string | null;
  mediaTypeName: string;
  areaSqFt: Prisma.Decimal | null;
  rateGrade: string | null;
};
