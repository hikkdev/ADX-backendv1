import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  createCategoryRuleHandler,
  createDimensionHandler,
  createRuleHandler,
  deleteCategoryRuleHandler,
  deleteDimensionHandler,
  deleteRuleHandler,
  getDimensionHandler,
  getQuoteHandler,
  getRuleHandler,
  getSettingsHandler,
  simulateHandler,
  updateSettingsHandler,
  listCategoryRulesHandler,
  listDimensionsHandler,
  listQuotesHandler,
  listRulesHandler,
  priceQuoteHandler,
  saveQuoteHandler,
  setConditionsHandler,
  setDimensionValuesHandler,
  setQuoteStatusHandler,
  updateCategoryRuleHandler,
  updateDimensionHandler,
  updateRuleHandler,
} from './price-model.controller';

export const priceModelRouter = Router();
priceModelRouter.use(authenticate);

/* Every lever here decides what an advertiser is charged, and a quote is an
 * offer made in ADX's name. Ops work throughout. */
priceModelRouter.use(requireRole('ADMIN'));

priceModelRouter.get('/settings', asyncHandler(getSettingsHandler));
priceModelRouter.put('/settings', asyncHandler(updateSettingsHandler));
priceModelRouter.post('/simulate', asyncHandler(simulateHandler));

priceModelRouter.get('/dimensions', asyncHandler(listDimensionsHandler));
priceModelRouter.post('/dimensions', asyncHandler(createDimensionHandler));
priceModelRouter.get('/dimensions/:id', asyncHandler(getDimensionHandler));
priceModelRouter.patch('/dimensions/:id', asyncHandler(updateDimensionHandler));
priceModelRouter.delete('/dimensions/:id', asyncHandler(deleteDimensionHandler));
priceModelRouter.put('/dimensions/:id/values', asyncHandler(setDimensionValuesHandler));

priceModelRouter.get('/category-rules', asyncHandler(listCategoryRulesHandler));
priceModelRouter.post('/category-rules', asyncHandler(createCategoryRuleHandler));
priceModelRouter.patch('/category-rules/:id', asyncHandler(updateCategoryRuleHandler));
priceModelRouter.delete('/category-rules/:id', asyncHandler(deleteCategoryRuleHandler));

priceModelRouter.get('/rules', asyncHandler(listRulesHandler));
priceModelRouter.post('/rules', asyncHandler(createRuleHandler));
priceModelRouter.get('/rules/:id', asyncHandler(getRuleHandler));
priceModelRouter.patch('/rules/:id', asyncHandler(updateRuleHandler));
priceModelRouter.delete('/rules/:id', asyncHandler(deleteRuleHandler));
priceModelRouter.put('/rules/:id/conditions', asyncHandler(setConditionsHandler));

/* `price` computes and returns; `quotes` writes one down. Kept apart because
 * negotiation is iterative and only the last version is worth keeping. */
priceModelRouter.post('/quotes/price', asyncHandler(priceQuoteHandler));
priceModelRouter.get('/quotes', asyncHandler(listQuotesHandler));
priceModelRouter.post('/quotes', asyncHandler(saveQuoteHandler));
priceModelRouter.get('/quotes/:id', asyncHandler(getQuoteHandler));
priceModelRouter.patch('/quotes/:id/status', asyncHandler(setQuoteStatusHandler));
