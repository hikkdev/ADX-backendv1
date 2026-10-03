import type { Request, Response } from 'express';
import type { z } from 'zod';
import { env } from '../../config/env';
import { ApiError } from '../../shared/errors';
import type { BoostPlacement } from '../../shared/database';
import { assertMayActFor, getAdvertiserForUser } from '../advertisers';
import { findPublisherForUser } from '../publishers';
import {
  adView,
  approveAd,
  cancelAd,
  createAd,
  findAdOrThrow,
  listAdsForDesk,
  listMyAds,
  payAdFromWallet,
  rejectAd,
  submitAd,
  updateAd,
  uploadArtwork,
  type AdActor,
} from './ads.service';
import {
  adminCancelBoost,
  assertMayActOnBoost,
  boostAvailability,
  boostView,
  cancelBoost,
  clearSponsoredCache,
  createBoost,
  findBoostOrThrow,
  listBoostsForDesk,
  listMyBoosts,
  payBoostFromWallet,
  quoteBoost,
  type BoostActor,
} from './boosts.service';
import { createSlot, listActivePlacements, listActiveSlots, listAllPlacements, listAllSlots, slotAvailability, updatePlacement, updateSlot } from './catalogue.service';
import {
  adminAdsQuerySchema,
  adminBoostsQuerySchema,
  adminCancelBoostSchema,
  approveSchema,
  artworkBodySchema,
  BOOST_PLACEMENTS,
  boostAvailabilityQuerySchema,
  boostQuoteQuerySchema,
  createAdSchema,
  createBoostSchema,
  createSlotSchema,
  eventsSchema,
  mineQuerySchema,
  optionalReasonSchema,
  reasonSchema,
  statsQuerySchema,
  updateAdSchema,
  updatePlacementSchema,
  updateSlotSchema,
  windowQuerySchema,
} from './promotions.schema';
import { adminStats, recordEvents } from './stats.service';

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  return parsed.data;
}

const param = (req: Request, name: string): string => String(req.params[name] ?? '');
const isAdmin = (req: Request): boolean => (req.user?.roles ?? []).includes('ADMIN');
const adActor = (req: Request): AdActor => ({ userId: req.user!.sub, isAdmin: isAdmin(req) });

async function boostActor(req: Request): Promise<BoostActor> {
  const publisher = await findPublisherForUser(req.user!.sub);
  return { userId: req.user!.sub, isAdmin: isAdmin(req), publisherId: publisher?.id ?? null };
}

/** `BASE_URL`, or outside production the request's Host header — where the stored artwork's public URL points. */
function baseUrlFor(req: Request): string {
  const hostHeader = req.headers['host'] ?? `localhost:${env.PORT}`;
  return env.BASE_URL ?? (env.NODE_ENV !== 'production' ? `http://${hostHeader}` : '');
}

/**
 * The advertiser a buyer route is for: the one named (an agent under the
 * act rule, or ADX on behalf — `assertMayActFor`), else the caller's own.
 */
async function advertiserFor(req: Request, requested: string | undefined, mode: 'READ' | 'WRITE', action?: string): Promise<string> {
  if (requested) {
    await assertMayActFor(req, requested, mode, action);
    return requested;
  }
  const own = await getAdvertiserForUser(req.user!.sub);
  if (!own) throw new ApiError(403, 'FORBIDDEN', isAdmin(req) ? 'Name the advertiser this booking is for (advertiserId)' : 'You have no advertiser account yet');
  return own.id;
}

/** The booking, once the caller may act on its advertiser. */
async function ownAd(req: Request, mode: 'READ' | 'WRITE', action?: string) {
  const row = await findAdOrThrow(param(req, 'id'));
  await assertMayActFor(req, row.advertiserId, mode, action);
  return row;
}

const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

/* ── Public / buyer reads ─────────────────────────────────────────── */

export async function listSlotsHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await listActiveSlots());
}

export async function slotAvailabilityHandler(req: Request, res: Response): Promise<void> {
  const query = parse(windowQuerySchema, req.query);
  ok(res, await slotAvailability(param(req, 'key'), query.from, query.to));
}

export async function listPlacementsHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await listActivePlacements());
}

export async function boostAvailabilityHandler(req: Request, res: Response): Promise<void> {
  const query = parse(boostAvailabilityQuerySchema, req.query);
  ok(res, await boostAvailability(query));
}

/* ── Advertiser: display ads ──────────────────────────────────────── */

export async function createAdHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createAdSchema, req.body);
  const advertiserId = await advertiserFor(req, body.advertiserId, 'WRITE', 'AD_BOOKING_CREATED_ON_BEHALF');
  ok(res, await createAd(advertiserId, body, adActor(req)), 201);
}

export async function myAdsHandler(req: Request, res: Response): Promise<void> {
  const query = parse(mineQuerySchema, req.query);
  const advertiserId = await advertiserFor(req, query.advertiserId, 'READ');
  ok(res, await listMyAds(advertiserId, query.status));
}

export async function getAdHandler(req: Request, res: Response): Promise<void> {
  ok(res, await adView(await ownAd(req, 'READ'), { stats: true }));
}

export async function updateAdHandler(req: Request, res: Response): Promise<void> {
  const body = parse(updateAdSchema, req.body);
  ok(res, await updateAd(await ownAd(req, 'WRITE', 'AD_BOOKING_UPDATED_ON_BEHALF'), body, adActor(req)));
}

export async function artworkHandler(req: Request, res: Response): Promise<void> {
  const body = parse(artworkBodySchema, req.body ?? {});
  const row = await ownAd(req, 'WRITE', 'AD_BOOKING_ARTWORK_ON_BEHALF');
  // The multipart temp file the uploads door wrote; `media` checks, stores and removes it.
  const file = req.file ? { path: req.file.path, filename: req.file.filename, originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size } : undefined;
  ok(res, await uploadArtwork(row, file, body, adActor(req), baseUrlFor(req)));
}

export async function submitAdHandler(req: Request, res: Response): Promise<void> {
  ok(res, await submitAd(await ownAd(req, 'WRITE', 'AD_BOOKING_SUBMITTED_ON_BEHALF'), adActor(req)));
}

export async function payAdHandler(req: Request, res: Response): Promise<void> {
  ok(res, await payAdFromWallet(await ownAd(req, 'WRITE', 'AD_BOOKING_PAID_ON_BEHALF'), adActor(req)));
}

export async function cancelAdHandler(req: Request, res: Response): Promise<void> {
  const body = parse(optionalReasonSchema, req.body ?? {});
  ok(res, await cancelAd(await ownAd(req, 'WRITE', 'AD_BOOKING_CANCELLED_ON_BEHALF'), body.reason, adActor(req)));
}

/* ── Publisher: sponsored listings ────────────────────────────────── */

export async function boostQuoteHandler(req: Request, res: Response): Promise<void> {
  const query = parse(boostQuoteQuerySchema, req.query);
  ok(res, await quoteBoost(query, await boostActor(req)));
}

export async function createBoostHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createBoostSchema, req.body);
  const view = await createBoost(body, await boostActor(req));
  ok(res, view, 201);
}

export async function myBoostsHandler(req: Request, res: Response): Promise<void> {
  const query = parse(mineQuerySchema, req.query);
  const actor = await boostActor(req);
  if (!actor.publisherId) throw new ApiError(403, 'FORBIDDEN', 'You have no publisher account yet');
  ok(res, await listMyBoosts(actor.publisherId, query.status));
}

export async function getBoostHandler(req: Request, res: Response): Promise<void> {
  const row = await findBoostOrThrow(param(req, 'id'));
  assertMayActOnBoost(row, await boostActor(req));
  ok(res, await boostView(row, { stats: true }));
}

export async function payBoostHandler(req: Request, res: Response): Promise<void> {
  const view = await payBoostFromWallet(await findBoostOrThrow(param(req, 'id')), await boostActor(req));
  clearSponsoredCache();
  ok(res, view);
}

export async function cancelBoostHandler(req: Request, res: Response): Promise<void> {
  const body = parse(optionalReasonSchema, req.body ?? {});
  const view = await cancelBoost(await findBoostOrThrow(param(req, 'id')), body.reason, await boostActor(req));
  clearSponsoredCache();
  ok(res, view);
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function adminListSlotsHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await listAllSlots());
}

export async function adminCreateSlotHandler(req: Request, res: Response): Promise<void> {
  ok(res, await createSlot(parse(createSlotSchema, req.body), req.user!.sub), 201);
}

export async function adminUpdateSlotHandler(req: Request, res: Response): Promise<void> {
  ok(res, await updateSlot(param(req, 'id'), parse(updateSlotSchema, req.body), req.user!.sub));
}

export async function adminListPlacementsHandler(_req: Request, res: Response): Promise<void> {
  ok(res, await listAllPlacements());
}

export async function adminUpdatePlacementHandler(req: Request, res: Response): Promise<void> {
  const placement = param(req, 'placement').toUpperCase();
  if (!(BOOST_PLACEMENTS as readonly string[]).includes(placement)) throw new ApiError(404, 'NOT_FOUND', 'Placement not found');
  const view = await updatePlacement(placement as BoostPlacement, parse(updatePlacementSchema, req.body), req.user!.sub);
  clearSponsoredCache();
  ok(res, view);
}

export async function adminListAdsHandler(req: Request, res: Response): Promise<void> {
  ok(res, await listAdsForDesk(parse(adminAdsQuerySchema, req.query)));
}

export async function adminGetAdHandler(req: Request, res: Response): Promise<void> {
  ok(res, await adView(await findAdOrThrow(param(req, 'id')), { stats: true }));
}

export async function adminApproveAdHandler(req: Request, res: Response): Promise<void> {
  const body = parse(approveSchema, req.body ?? {});
  ok(res, await approveAd(param(req, 'id'), body.note, req.user!.sub));
}

export async function adminRejectAdHandler(req: Request, res: Response): Promise<void> {
  const body = parse(reasonSchema, req.body);
  ok(res, await rejectAd(param(req, 'id'), body.reason, req.user!.sub));
}

export async function adminListBoostsHandler(req: Request, res: Response): Promise<void> {
  ok(res, await listBoostsForDesk(parse(adminBoostsQuerySchema, req.query)));
}

export async function adminGetBoostHandler(req: Request, res: Response): Promise<void> {
  ok(res, await boostView(await findBoostOrThrow(param(req, 'id')), { stats: true }));
}

export async function adminCancelBoostHandler(req: Request, res: Response): Promise<void> {
  const body = parse(adminCancelBoostSchema, req.body);
  const view = await adminCancelBoost(param(req, 'id'), body, req.user!.sub);
  clearSponsoredCache();
  ok(res, view);
}

export async function adminStatsHandler(req: Request, res: Response): Promise<void> {
  const query = parse(statsQuerySchema, req.query);
  ok(res, await adminStats(query.from, query.to));
}

/* ── Events ───────────────────────────────────────────────────────── */

export async function eventsHandler(req: Request, res: Response): Promise<void> {
  const body = parse(eventsSchema, req.body);
  ok(res, await recordEvents(body.events), 202);
}
