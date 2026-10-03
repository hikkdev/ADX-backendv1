import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
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

priceModelRouter.get('/settings', requirePermission('pricing.view'), asyncHandler(getSettingsHandler));
priceModelRouter.put('/settings', requirePermission('pricing.edit'), asyncHandler(updateSettingsHandler));
priceModelRouter.post('/simulate', requirePermission('pricing.view'), asyncHandler(simulateHandler));

priceModelRouter.get('/dimensions', requirePermission('pricing.view'), asyncHandler(listDimensionsHandler));
priceModelRouter.post('/dimensions', requirePermission('pricing.edit'), asyncHandler(createDimensionHandler));
priceModelRouter.get('/dimensions/:id', requirePermission('pricing.view'), asyncHandler(getDimensionHandler));
priceModelRouter.patch('/dimensions/:id', requirePermission('pricing.edit'), asyncHandler(updateDimensionHandler));
priceModelRouter.delete('/dimensions/:id', requirePermission('pricing.delete'), asyncHandler(deleteDimensionHandler));
priceModelRouter.put('/dimensions/:id/values', requirePermission('pricing.edit'), asyncHandler(setDimensionValuesHandler));

priceModelRouter.get('/category-rules', requirePermission('pricing.view'), asyncHandler(listCategoryRulesHandler));
priceModelRouter.post('/category-rules', requirePermission('pricing.edit'), asyncHandler(createCategoryRuleHandler));
priceModelRouter.patch('/category-rules/:id', requirePermission('pricing.edit'), asyncHandler(updateCategoryRuleHandler));
priceModelRouter.delete('/category-rules/:id', requirePermission('pricing.delete'), asyncHandler(deleteCategoryRuleHandler));

priceModelRouter.get('/rules', requirePermission('pricing.view'), asyncHandler(listRulesHandler));
priceModelRouter.post('/rules', requirePermission('pricing.edit'), asyncHandler(createRuleHandler));
priceModelRouter.get('/rules/:id', requirePermission('pricing.view'), asyncHandler(getRuleHandler));
priceModelRouter.patch('/rules/:id', requirePermission('pricing.edit'), asyncHandler(updateRuleHandler));
priceModelRouter.delete('/rules/:id', requirePermission('pricing.delete'), asyncHandler(deleteRuleHandler));
priceModelRouter.put('/rules/:id/conditions', requirePermission('pricing.edit'), asyncHandler(setConditionsHandler));

/* `price` computes and returns; `quotes` writes one down. Kept apart because
 * negotiation is iterative and only the last version is worth keeping. */
priceModelRouter.post('/quotes/price', requirePermission('pricing.view'), asyncHandler(priceQuoteHandler));
priceModelRouter.get('/quotes', requirePermission('pricing.view'), asyncHandler(listQuotesHandler));
priceModelRouter.post('/quotes', requirePermission('pricing.edit'), asyncHandler(saveQuoteHandler));
priceModelRouter.get('/quotes/:id', requirePermission('pricing.view'), asyncHandler(getQuoteHandler));
priceModelRouter.patch('/quotes/:id/status', requirePermission('pricing.edit'), asyncHandler(setQuoteStatusHandler));
