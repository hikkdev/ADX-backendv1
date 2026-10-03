import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import type { BoostPlacement } from '../../shared/database';
import { specFor as mediaSpecFor, type MediaSpec } from '../media';
import { addDays, availability, daysBetween, firstFreeDay, MAX_WINDOW_DAYS, parseDay, type DayAvailability } from './pricing';
import { prismaPromotionsRepository as repository } from './prisma-promotions.repository';
import type { AdSlotRow, BoostScope, PlacementRow } from './promotions.repository';
import type { CreateSlotInput, UpdatePlacementInput, UpdateSlotInput } from './promotions.schema';

/**
 * LM-1 — what ADX sells: the ad slots and the two boost placements, their
 * prices and capacity, and the per-day availability a buyer picks dates from.
 * The desk edits every figure (Growth › Promotions); a price change applies
 * to bookings made after it — a booking keeps the rate it was quoted.
 */

export type SlotView = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  surfaces: string[];
  spec: string;
  /** The artwork size the spec names, for the upload screen. */
  specDetail: MediaSpec | null;
  ratePerDay: Money;
  minDays: number;
  maxConcurrent: number;
  isActive: boolean;
};

export type PlacementView = { placement: BoostPlacement; label: string; ratePerDay: Money; minDays: number; maxConcurrent: number; isActive: boolean };

/** The artwork spec a slot names — `media`'s list, the one `GET /media/specs` answers, so the two never disagree. */
export const specFor = (key: string): MediaSpec | null => mediaSpecFor(key);

export function toSlotView(slot: AdSlotRow): SlotView {
  return {
    id: slot.id,
    key: slot.key,
    label: slot.label,
    description: slot.description,
    surfaces: [...slot.surfaces],
    spec: slot.spec,
    specDetail: specFor(slot.spec),
    ratePerDay: money(slot.ratePerDay),
    minDays: slot.minDays,
    maxConcurrent: slot.maxConcurrent,
    isActive: slot.isActive,
  };
}

export function toPlacementView(row: PlacementRow): PlacementView {
  return { placement: row.placement, label: row.label, ratePerDay: money(row.ratePerDay), minDays: row.minDays, maxConcurrent: row.maxConcurrent, isActive: row.isActive };
}

/** `GET /promotions/slots` — the active slots, as a buyer picks from them. */
export async function listActiveSlots(): Promise<Omit<SlotView, 'id' | 'isActive'>[]> {
  const slots = await repository.listSlots(true);
  return slots.map((slot) => {
    const { id: _id, isActive: _active, ...view } = toSlotView(slot);
    return view;
  });
}

export async function activeSlotByKey(key: string): Promise<AdSlotRow> {
  const slot = await repository.findSlotByKey(key);
  if (!slot || !slot.isActive) throw new ApiError(404, 'NOT_FOUND', 'That ad slot is not on sale');
  return slot;
}

/** A window of days a read was asked for: both ends, the end on or after the start, at most 186 days. */
export function windowOf(fromText: string, toText: string): { from: Date; to: Date } {
  const from = parseDay(fromText, 'from');
  const to = parseDay(toText, 'to');
  const days = daysBetween(from, to);
  if (days < 1) throw new ApiError(400, 'VALIDATION_ERROR', '`to` must be on or after `from`');
  if (days > MAX_WINDOW_DAYS) throw new ApiError(400, 'VALIDATION_ERROR', `Ask for at most ${MAX_WINDOW_DAYS} days at a time`);
  return { from, to };
}

/**
 * `GET /promotions/slots/:key/availability` — each day of the window with
 * what is booked and what is left, and the first day with room: inside the
 * window when there is one, else the first after it within 186 days.
 */
export async function slotAvailability(key: string, fromText: string, toText: string): Promise<{ slotKey: string; maxConcurrent: number; days: DayAvailability[]; nextFreeDate: string | null }> {
  const slot = await activeSlotByKey(key);
  const { from, to } = windowOf(fromText, toText);
  const days = availability(await repository.adHolds(slot.id, from, to), from, to, slot.maxConcurrent);
  let nextFreeDate = firstFreeDay(days);
  if (!nextFreeDate) {
    const beyondFrom = addDays(to, 1);
    const beyondTo = addDays(to, MAX_WINDOW_DAYS);
    nextFreeDate = firstFreeDay(availability(await repository.adHolds(slot.id, beyondFrom, beyondTo), beyondFrom, beyondTo, slot.maxConcurrent));
  }
  return { slotKey: slot.key, maxConcurrent: slot.maxConcurrent, days, nextFreeDate };
}

/** `GET /promotions/boost/placements` — the active placements. */
export async function listActivePlacements(): Promise<Omit<PlacementView, 'isActive'>[]> {
  const rows = await repository.listPlacements();
  return rows.filter((row) => row.isActive).map((row) => {
    const { isActive: _active, ...view } = toPlacementView(row);
    return view;
  });
}

export async function activePlacements(placements: readonly BoostPlacement[]): Promise<PlacementRow[]> {
  const rows = await repository.listPlacements();
  return placements.map((placement) => {
    const row = rows.find((candidate) => candidate.placement === placement);
    if (!row || !row.isActive) throw new ApiError(409, 'CONFLICT', `${placement === 'SEARCH_TOP' ? 'Top of search results' : 'Top of similar listings'} is not on sale right now`, { placement });
    return row;
  });
}

/** Per placement, each day's booked and left in the listing's city and category. */
export async function placementAvailability(
  scope: Omit<BoostScope, 'placement'>,
  placements: readonly PlacementRow[],
  from: Date,
  to: Date,
  excludeId?: string,
): Promise<{ placement: BoostPlacement; maxConcurrent: number; days: DayAvailability[] }[]> {
  return Promise.all(
    placements.map(async (row) => ({
      placement: row.placement,
      maxConcurrent: row.maxConcurrent,
      days: availability(await repository.boostHolds({ ...scope, placement: row.placement }, from, to, excludeId), from, to, row.maxConcurrent),
    })),
  );
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function listAllSlots(): Promise<SlotView[]> {
  return (await repository.listSlots(false)).map(toSlotView);
}

export async function createSlot(input: CreateSlotInput, byUserId: string): Promise<SlotView> {
  if (await repository.findSlotByKey(input.key)) throw new ApiError(409, 'CONFLICT', `A slot keyed ${input.key} already exists`);
  const slot = await repository.createSlot({
    key: input.key,
    label: input.label,
    description: input.description ?? null,
    surfaces: input.surfaces,
    spec: input.spec,
    maxConcurrent: input.maxConcurrent,
    ratePerDay: new Decimal(input.ratePerDay),
    minDays: input.minDays ?? 1,
    isActive: input.isActive ?? true,
  });
  await logActivity(byUserId, 'AD_SLOT_CREATED', { module: 'promotions', targetType: 'AdSlot', targetId: slot.id, metadata: { key: slot.key, ratePerDay: money(slot.ratePerDay) } });
  return toSlotView(slot);
}

export async function updateSlot(idOrKey: string, input: UpdateSlotInput, byUserId: string): Promise<SlotView> {
  const before = await repository.findSlot(idOrKey);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Ad slot not found');
  const slot = await repository.updateSlot(before.id, {
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.surfaces !== undefined ? { surfaces: input.surfaces } : {}),
    ...(input.spec !== undefined ? { spec: input.spec } : {}),
    ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
    ...(input.ratePerDay !== undefined ? { ratePerDay: new Decimal(input.ratePerDay) } : {}),
    ...(input.minDays !== undefined ? { minDays: input.minDays } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  });
  await logActivity(byUserId, 'AD_SLOT_UPDATED', {
    module: 'promotions',
    targetType: 'AdSlot',
    targetId: slot.id,
    diff: auditDiff(toSlotView(before), toSlotView(slot)),
    metadata: { key: slot.key },
  });
  return toSlotView(slot);
}

export async function listAllPlacements(): Promise<PlacementView[]> {
  return (await repository.listPlacements()).map(toPlacementView);
}

export async function updatePlacement(placement: BoostPlacement, input: UpdatePlacementInput, byUserId: string): Promise<PlacementView> {
  const before = await repository.findPlacement(placement);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Placement not found');
  const row = await repository.updatePlacement(placement, {
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.ratePerDay !== undefined ? { ratePerDay: new Decimal(input.ratePerDay) } : {}),
    ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
    ...(input.minDays !== undefined ? { minDays: input.minDays } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  });
  await logActivity(byUserId, 'BOOST_PLACEMENT_UPDATED', {
    module: 'promotions',
    targetType: 'BoostPlacementConfig',
    targetId: placement,
    diff: auditDiff(toPlacementView(before), toPlacementView(row)),
  });
  return toPlacementView(row);
}
