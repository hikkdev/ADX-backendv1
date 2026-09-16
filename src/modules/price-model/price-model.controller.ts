import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../../shared/errors';
import {
  conditionsSchema,
  createCategoryRuleSchema,
  createDimensionSchema,
  createRuleSchema,
  dimensionValuesSchema,
  quoteListQuerySchema,
  quoteSchema,
  quoteStatusSchema,
  settingsPatchSchema,
  simulateSchema,
  updateCategoryRuleSchema,
  updateDimensionSchema,
  updateRuleSchema,
} from './price-model.schema';
import { getSettings, updateSettings } from './settings.service';
import { simulate } from './simulate.service';
import {
  createCategoryRule,
  createDimension,
  createRule,
  deleteCategoryRule,
  deleteDimension,
  deleteRule,
  getDimension,
  getRule,
  listCategoryRules,
  listDimensions,
  listRules,
  setConditions,
  setDimensionValues,
  updateCategoryRule,
  updateDimension,
  updateRule,
} from './price-model.service';
import {
  getQuote,
  listQuotes,
  priceQuote,
  saveQuote,
  setQuoteStatus,
} from './quote.service';

const id = (req: Request) => req.params['id'] as string;

function parse<T>(schema: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

const dates = <T extends { startsAt?: string | null; endsAt?: string | null }>(body: T) => ({
  ...body,
  startsAt: body.startsAt ? new Date(body.startsAt) : (body.startsAt as null | undefined),
  endsAt: body.endsAt ? new Date(body.endsAt) : (body.endsAt as null | undefined),
});

/* ── Dimensions ──────────────────────────────────────────────────────── */

export async function listDimensionsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listDimensions(req.query['all'] === 'true') });
}

export async function getDimensionHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getDimension(id(req)) });
}

export async function createDimensionHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof createDimension>[0]>(createDimensionSchema, req.body);
  res.status(201).json({ success: true, data: await createDimension(body) });
}

export async function updateDimensionHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof updateDimension>[1]>(updateDimensionSchema, req.body);
  res.json({ success: true, data: await updateDimension(id(req), body) });
}

export async function deleteDimensionHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await deleteDimension(id(req)) });
}

export async function setDimensionValuesHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ values: Parameters<typeof setDimensionValues>[1] }>(
    dimensionValuesSchema,
    req.body
  );
  res.json({ success: true, data: await setDimensionValues(id(req), body.values) });
}

/* ── Category rules ──────────────────────────────────────────────────── */

export async function listCategoryRulesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listCategoryRules() });
}

export async function createCategoryRuleHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof createCategoryRule>[0]>(
    createCategoryRuleSchema,
    req.body
  );
  res.status(201).json({ success: true, data: await createCategoryRule(body) });
}

export async function updateCategoryRuleHandler(req: Request, res: Response): Promise<void> {
  const body = parse<Parameters<typeof updateCategoryRule>[1]>(
    updateCategoryRuleSchema,
    req.body
  );
  res.json({ success: true, data: await updateCategoryRule(id(req), body) });
}

export async function deleteCategoryRuleHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await deleteCategoryRule(id(req)) });
}

/* ── Rules ───────────────────────────────────────────────────────────── */

export async function listRulesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listRules(req.query['all'] === 'true') });
}

export async function getRuleHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getRule(id(req)) });
}

export async function createRuleHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof createRuleSchema>>(createRuleSchema, req.body);
  res.status(201).json({ success: true, data: await createRule(dates(body)) });
}

export async function updateRuleHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof updateRuleSchema>>(updateRuleSchema, req.body);
  res.json({ success: true, data: await updateRule(id(req), dates(body)) });
}

export async function deleteRuleHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await deleteRule(id(req)) });
}

export async function setConditionsHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ conditions: Parameters<typeof setConditions>[1] }>(
    conditionsSchema,
    req.body
  );
  res.json({ success: true, data: await setConditions(id(req), body.conditions) });
}

/* ── Quotes ──────────────────────────────────────────────────────────── */

/**
 * Prices without saving.
 *
 * Negotiation is iterative — the operator moves the discount, sees where it
 * lands against the floors, moves it back — and writing a row for each of those
 * would fill the table with abandoned arithmetic.
 */
export async function priceQuoteHandler(req: Request, res: Response): Promise<void> {
  // `expiresAt` is dropped rather than parsed: pricing does not depend on when
  // the offer lapses, and only the saved quote records it.
  const { expiresAt: _ignored, ...body } = parse<z.infer<typeof quoteSchema>>(
    quoteSchema,
    req.body
  );
  res.json({
    success: true,
    data: await priceQuote({ ...body, createdById: req.user!.sub }),
  });
}

export async function saveQuoteHandler(req: Request, res: Response): Promise<void> {
  const { expiresAt, ...body } = parse<z.infer<typeof quoteSchema>>(quoteSchema, req.body);
  const data = await saveQuote({
    ...body,
    createdById: req.user!.sub,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  });
  res.status(201).json({ success: true, data });
}

export async function listQuotesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<{ status?: string }>(quoteListQuerySchema, req.query);
  res.json({ success: true, data: await listQuotes(query.status) });
}

export async function getQuoteHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getQuote(id(req)) });
}

export async function setQuoteStatusHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ status: string }>(quoteStatusSchema, req.body);
  res.json({ success: true, data: await setQuoteStatus(id(req), body.status) });
}

/* ── Settings ────────────────────────────────────────────────────────── */

export async function getSettingsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getSettings() });
}

export async function updateSettingsHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof settingsPatchSchema>>(settingsPatchSchema, req.body);
  res.json({ success: true, data: await updateSettings(body, req.user!.sub) });
}

/* ── Simulator ───────────────────────────────────────────────────────── */

export async function simulateHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof simulateSchema>>(simulateSchema, req.body);
  res.json({ success: true, data: await simulate(body) });
}
