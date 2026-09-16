import { ApiError } from '../../shared/errors';
import { Decimal } from '../../shared/money';
import type { CategoryRuleEffect, PriceRuleAdjustment } from '../../shared/database';
import { prismaPriceModelRepository as repository } from './prisma-price-model.repository';
import type { ConditionInput, DimensionValueInput, PriceRuleRow } from './price-model.repository';

/**
 * The manual pricing model: the levers ops pulls by hand.
 *
 * Three of them, and they are different shapes on purpose.
 *
 * **Dimensions** are mutually exclusive: a spot is back-lit or front-lit, never
 * both, so a quote picks one value per dimension.
 *
 * **Category rules** are about who is buying rather than what they are buying,
 * and they can refuse outright — a sector that may not book this media type at
 * all is a real answer, and a price of infinity is not how to express it.
 *
 * **Rules** are conditional and ordered. Priority is explicit because "which
 * rule won" is what somebody asks when a price looks wrong.
 *
 * None of this computes from the market. That is the comparables engine's job
 * and it is deliberately a separate module.
 */

/* ------------------------------------------------------------------ */
/* Dimensions                                                          */
/* ------------------------------------------------------------------ */

export const listDimensions = (includeInactive = false) =>
  repository.listDimensions(includeInactive);

export async function getDimension(id: string) {
  const dimension = await repository.findDimension(id);
  if (!dimension) throw new ApiError(404, 'NOT_FOUND', 'Dimension not found');
  return dimension;
}

export const createDimension = (data: { name: string; slug: string; description?: string | null; sortOrder?: number }) =>
  repository.createDimension(data);

export async function updateDimension(
  id: string,
  patch: { name?: string; slug?: string; description?: string | null; sortOrder?: number; isActive?: boolean }
) {
  await getDimension(id);
  return repository.updateDimension(id, patch);
}

export async function deleteDimension(id: string) {
  await getDimension(id);
  await repository.deleteDimension(id);
  return { deleted: true };
}

export async function setDimensionValues(
  id: string,
  values: {
    label: string;
    multiplier: string;
    minAreaSqFt?: string | null;
    maxAreaSqFt?: string | null;
    isActive?: boolean;
  }[]
) {
  await getDimension(id);

  const shaped: DimensionValueInput[] = values.map((value, index) => ({
    label: value.label,
    multiplier: new Decimal(value.multiplier),
    minAreaSqFt: value.minAreaSqFt ? new Decimal(value.minAreaSqFt) : null,
    maxAreaSqFt: value.maxAreaSqFt ? new Decimal(value.maxAreaSqFt) : null,
    sortOrder: index,
    isActive: value.isActive ?? true,
  }));

  // A band whose range runs backwards would silently never match anything.
  for (const value of shaped) {
    if (value.minAreaSqFt && value.maxAreaSqFt && value.minAreaSqFt.greaterThan(value.maxAreaSqFt)) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `"${value.label}" has a minimum area above its maximum, so nothing would ever fall in it.`
      );
    }
  }

  await repository.replaceDimensionValues(id, shaped);
  return getDimension(id);
}

/* ------------------------------------------------------------------ */
/* Category rules                                                      */
/* ------------------------------------------------------------------ */

export const listCategoryRules = () => repository.listCategoryRules();

function assertRuleShape(effect: CategoryRuleEffect, multiplier?: string | null) {
  if (effect === 'MULTIPLIER' && !multiplier) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A multiplier rule needs a multiplier.');
  }
  if (effect !== 'MULTIPLIER' && multiplier) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Only a multiplier rule carries a multiplier — a blocked sector has no price.'
    );
  }
}

export function createCategoryRule(data: {
  sector: string;
  mediaTypeId?: string | null;
  effect: CategoryRuleEffect;
  multiplier?: string | null;
  note?: string | null;
}) {
  assertRuleShape(data.effect, data.multiplier);
  return repository.createCategoryRule({
    ...data,
    multiplier: data.multiplier ? new Decimal(data.multiplier) : null,
  });
}

export function updateCategoryRule(
  id: string,
  patch: {
    sector?: string;
    mediaTypeId?: string | null;
    effect?: CategoryRuleEffect;
    multiplier?: string | null;
    note?: string | null;
    isActive?: boolean;
  }
) {
  if (patch.effect) assertRuleShape(patch.effect, patch.multiplier);
  const { multiplier, ...rest } = patch;
  return repository.updateCategoryRule(id, {
    ...rest,
    ...(multiplier !== undefined ? { multiplier: multiplier ? new Decimal(multiplier) : null } : {}),
  });
}

export async function deleteCategoryRule(id: string) {
  await repository.deleteCategoryRule(id);
  return { deleted: true };
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

export const listRules = (includeInactive = false) => repository.listRules(includeInactive);

export async function getRule(id: string) {
  const rule = await repository.findRule(id);
  if (!rule) throw new ApiError(404, 'NOT_FOUND', 'Rule not found');
  return rule;
}

export const createRule = (data: {
  name: string;
  description?: string | null;
  priority?: number;
  matchAny?: boolean;
  adjustment: PriceRuleAdjustment;
  value: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
}) => repository.createRule({ ...data, value: new Decimal(data.value) });

export async function updateRule(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    priority?: number;
    matchAny?: boolean;
    adjustment?: PriceRuleAdjustment;
    value?: string;
    startsAt?: Date | null;
    endsAt?: Date | null;
    isActive?: boolean;
  }
) {
  await getRule(id);
  const { value, ...rest } = patch;
  return repository.updateRule(id, {
    ...rest,
    ...(value !== undefined ? { value: new Decimal(value) } : {}),
  });
}

export async function deleteRule(id: string) {
  await getRule(id);
  await repository.deleteRule(id);
  return { deleted: true };
}

const OPERATORS = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte'] as const;

export async function setConditions(id: string, conditions: ConditionInput[]) {
  await getRule(id);
  for (const condition of conditions) {
    if (!OPERATORS.includes(condition.operator as (typeof OPERATORS)[number])) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Unknown operator "${condition.operator}".`);
    }
  }
  await repository.replaceConditions(id, conditions);
  return getRule(id);
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/** The facts a rule is tested against. */
export type QuoteFacts = {
  mediaTypeId: string;
  grade: string;
  city?: string | null;
  sector?: string | null;
  areaSqFt?: string | null;
  days?: number;
};

/**
 * Whether one clause holds.
 *
 * Ordering operators parse both sides as numbers and answer false when either
 * side is not one — a rule that tests `areaSqFt > 200` against a spot with no
 * measured area has not matched, and treating the missing value as zero would
 * fire it on every unmeasured listing.
 */
function clauseHolds(condition: ConditionInput, facts: QuoteFacts): boolean {
  const actual = (facts as Record<string, unknown>)[condition.field];
  if (actual === undefined || actual === null) return false;

  const left = String(actual);

  switch (condition.operator) {
    case 'eq':
      return left.toLowerCase() === condition.value.toLowerCase();
    case 'ne':
      return left.toLowerCase() !== condition.value.toLowerCase();
    case 'in':
      return condition.value
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .includes(left.toLowerCase());
    default: {
      const a = Number(left);
      const b = Number(condition.value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (condition.operator === 'gt') return a > b;
      if (condition.operator === 'gte') return a >= b;
      if (condition.operator === 'lt') return a < b;
      if (condition.operator === 'lte') return a <= b;
      return false;
    }
  }
}

/**
 * Whether a rule fires. Match ALL needs every clause; Match ANY needs one. A
 * rule with no clauses fires on everything either way — an empty ANY would
 * otherwise never fire, which is not what anybody writing it meant.
 */
export const ruleMatches = (rule: PriceRuleRow, facts: QuoteFacts): boolean =>
  rule.conditions.length === 0
    ? true
    : rule.matchAny
      ? rule.conditions.some((condition) => clauseHolds(condition, facts))
      : rule.conditions.every((condition) => clauseHolds(condition, facts));

export const rulesFor = async (facts: QuoteFacts, on = new Date()): Promise<PriceRuleRow[]> =>
  (await repository.rulesInForce(on)).filter((rule) => ruleMatches(rule, facts));

/** The size band a measured area falls in, if any dimension defines bands. */
export async function bandForArea(areaSqFt: string) {
  const area = new Decimal(areaSqFt);
  for (const dimension of await repository.listDimensions()) {
    for (const value of dimension.values) {
      if (!value.isActive || (!value.minAreaSqFt && !value.maxAreaSqFt)) continue;
      const aboveMin = !value.minAreaSqFt || area.greaterThanOrEqualTo(value.minAreaSqFt);
      const belowMax = !value.maxAreaSqFt || area.lessThanOrEqualTo(value.maxAreaSqFt);
      if (aboveMin && belowMax) return { dimension, value };
    }
  }
  return null;
}

export const categoryRuleFor = (sector: string, mediaTypeId: string) =>
  repository.findCategoryRule(sector, mediaTypeId);

export const dimensionValues = async (ids: string[]) => {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  const out: { dimensionName: string; label: string; multiplier: Decimal }[] = [];
  for (const dimension of await repository.listDimensions()) {
    for (const value of dimension.values) {
      if (wanted.has(value.id)) {
        out.push({
          dimensionName: dimension.name,
          label: value.label,
          multiplier: new Decimal(value.multiplier),
        });
      }
    }
  }
  return out;
};
