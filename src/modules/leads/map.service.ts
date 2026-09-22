import { redis } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { money } from '../../shared/money';
import { findAgentProfile, findAgentTier, requireAgentProfile } from '../agents';
import { getPlatformSettings } from '../app-config';
import { notify } from '../notifications';
import { recordIncentiveOnce } from '../payouts';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';
import { distanceM } from './prisma-leads.repository';
import { toLeadCard } from './leads.service';
import type { LeadRow } from './leads.service';
import { registerTerritoryRouter } from './routing.service';
import { advanceStage, registerActivationHook } from './stages.service';
import { touchLead } from './scoring.service';
import {
  CLUSTER_ABOVE_KM2,
  PIN_CAP,
  bboxAreaKm2,
  bboxOfRing,
  claimVerdict,
  clusterPoints,
  inRing,
  parseRing,
  topUpAllowed,
  zoneCovers,
  type BBox,
  type Ring,
  type ZoneRow,
} from './map.rules';

/**
 * LH5 (the Lead Hunt, 22 Sep 2026): the hunting grounds.
 *
 * One `GET /leads/map` answering a viewport — clusters above sixty square
 * kilometres, pins below, capped like browse — for the ops map and the
 * agent's; territories (D8, route-only) and priority zones (D7, a top-up
 * under a cap) as rows ops draw; claims with a 72-hour hold, caps by tier
 * and a cooldown (D3); the hourly lapse; the three alerts under quiet
 * hours (a hot lead within a kilometre, a claim about to lapse, a link
 * opened). No PostGIS: bounding boxes the index takes, rings in code.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** One push per key per window — the alerts are not a drumbeat. */
async function once(key: string, ttlSec: number): Promise<boolean> {
  try {
    return (await redis.set(`lead-alert:${key}`, '1', 'EX', ttlSec, 'NX')) === 'OK';
  } catch {
    return true;
  }
}

/* ── the viewport ──────────────────────────────────────────────────────── */

export type MapQuery = {
  bbox: BBox;
  side?: 'PUBLISHER' | 'ADVERTISER' | undefined;
  temperature?: 'HOT' | 'WARM' | 'COLD' | undefined;
  priority?: boolean | undefined;
  claimed?: 'MINE' | 'OPEN' | 'ANY' | undefined;
  category?: string | undefined;
  /** Pins even above the cluster threshold — the console's bulk plot after an import. */
  pins?: boolean | undefined;
};

export async function mapView(query: MapQuery, viewer: { userId: string; isAdmin: boolean }, now = new Date()) {
  const agent = viewer.isAdmin ? null : await findAgentProfile(viewer.userId);
  const rows = await repository.findOpenInBBox(query.bbox, { side: query.side, temperature: query.temperature, category: query.category }, PIN_CAP * 4);
  const zones = query.priority ? (await activeZones(now)).filter((zone) => zone.ring) : [];
  const filtered = rows.filter((row) => {
    if (row.latitude === null || row.longitude === null) return false;
    if (query.claimed === 'MINE' && !(agent && (row.claimedByAgentId === agent.id || row.assignedAgentId === agent.id))) return false;
    if (query.claimed === 'OPEN' && (row.assignedAgentId || (row.claimedByAgentId && row.claimExpiresAt && row.claimExpiresAt > now))) return false;
    if (query.priority && !zones.some((zone) => zoneCovers(zone, row, now))) return false;
    return true;
  });
  const placed = filtered.map((row) => ({ ...row, latitude: row.latitude!, longitude: row.longitude! }));
  const area = bboxAreaKm2(query.bbox);
  const clustered = !query.pins && area > CLUSTER_ABOVE_KM2;
  const territories = viewer.isAdmin ? await repository.listTerritories({ activeOnly: true }) : [];
  const zoneRings = (await activeZones(now)).filter((zone) => zone.ring).map((zone) => ({ id: zone.id, name: zone.name, ring: zone.ring, topUp: zone.topUp }));
  return {
    mode: clustered ? 'CLUSTERS' : 'PINS',
    total: placed.length,
    clusters: clustered ? clusterPoints(placed, query.bbox) : [],
    pins: clustered
      ? []
      : placed.slice(0, PIN_CAP).map((row) => ({
          ...pinOf(row, agent?.id ?? null, now),
          priority: zoneRings.some((zone) => inRing({ latitude: row.latitude, longitude: row.longitude }, zone.ring as Ring)),
        })),
    zones: zoneRings.map((zone) => ({ id: zone.id, name: zone.name, polygon: zone.ring, topUp: money(zone.topUp) })),
    territories: territories.map((row) => ({ id: row.id, name: row.name, side: row.side, agentId: row.agentId, polygon: row.polygon })),
  };
}

function pinOf(row: LeadRow & { latitude: number; longitude: number; claimedByAgentId?: string | null; claimExpiresAt?: Date | null }, agentId: string | null, now: Date) {
  const held = row.claimedByAgentId && row.claimExpiresAt && row.claimExpiresAt > now ? row.claimedByAgentId : row.assignedAgentId;
  return {
    id: row.id,
    displayId: row.displayId,
    side: row.side,
    businessName: row.businessName,
    category: row.category,
    latitude: row.latitude,
    longitude: row.longitude,
    temperature: row.temperature ?? null,
    score: row.score ?? null,
    estimatedValue: row.estimatedValue === null || row.estimatedValue === undefined ? null : money(row.estimatedValue as never),
    estimatedCommission: row.estimatedCommission === null || row.estimatedCommission === undefined ? null : money(row.estimatedCommission as never),
    stage: row.stage ?? 'SOURCED',
    claim: held ? { agentId: held, mine: agentId !== null && held === agentId, expiresAt: row.claimExpiresAt && row.claimExpiresAt > now ? row.claimExpiresAt.toISOString() : null } : null,
  };
}

/* ── the heat: demand over supply, by grid cell ────────────────────────── */

export async function heatView(bbox: BBox, side: 'PUBLISHER' | 'ADVERTISER' | undefined, now = new Date()) {
  const since = new Date(now.getTime() - 90 * DAY_MS);
  const [supply, demand] = await Promise.all([repository.liveListingPoints(bbox, PIN_CAP * 4), repository.demandPoints(bbox, since, PIN_CAP * 4)]);
  const cell = Math.max(0.0045, Math.min(bbox.north - bbox.south, bbox.east - bbox.west) / 12);
  const cells = new Map<string, { lat: number; lng: number; supply: number; demand: number }>();
  const bump = (point: { latitude: number; longitude: number }, key: 'supply' | 'demand') => {
    const id = `${Math.floor(point.latitude / cell)}:${Math.floor(point.longitude / cell)}`;
    const row = cells.get(id) ?? { lat: (Math.floor(point.latitude / cell) + 0.5) * cell, lng: (Math.floor(point.longitude / cell) + 0.5) * cell, supply: 0, demand: 0 };
    row[key] += 1;
    cells.set(id, row);
  };
  for (const point of supply) bump(point, 'supply');
  for (const point of demand) bump(point, 'demand');
  return {
    cellDeg: cell,
    cells: [...cells.values()].map((row) => ({
      latitude: row.lat,
      longitude: row.lng,
      supply: row.supply,
      demand: row.demand,
      // Where publisher leads are worth the most: demand with thin supply. Where advertiser leads are easy: supply is rich.
      gap: row.demand - row.supply,
      weight: side === 'ADVERTISER' ? row.supply : Math.max(0, row.demand - row.supply) + row.demand * 0.25,
    })),
  };
}

/* ── territories (D8) ──────────────────────────────────────────────────── */

export type TerritoryInput = { name: string; side: 'PUBLISHER' | 'ADVERTISER'; polygon: unknown; agentId: string; city?: string | undefined };

export async function createTerritory(input: TerritoryInput, byUserId: string) {
  const ring = parseRing(input.polygon);
  if (!ring) throw new ApiError(400, 'VALIDATION_ERROR', 'Draw a polygon of at least three corners');
  const agent = await repository.findAgentBrief(input.agentId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'No such agent');
  if (!agent.sides.includes(input.side)) throw new ApiError(400, 'VALIDATION_ERROR', `That agent does not work the ${input.side.toLowerCase()} side`);
  const box = bboxOfRing(ring);
  const row = await repository.createTerritory({ name: input.name, side: input.side, polygon: ring, ...box, agentId: input.agentId, city: input.city ?? agent.city ?? null, cityId: agent.cityId, createdById: byUserId });
  return territoryView(row);
}

export async function updateTerritory(id: string, patch: { name?: string | undefined; polygon?: unknown; agentId?: string | undefined; isActive?: boolean | undefined }) {
  const existing = await repository.findTerritory(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'No such territory');
  const ring = patch.polygon !== undefined ? parseRing(patch.polygon) : null;
  if (patch.polygon !== undefined && !ring) throw new ApiError(400, 'VALIDATION_ERROR', 'Draw a polygon of at least three corners');
  if (patch.agentId) {
    const agent = await repository.findAgentBrief(patch.agentId);
    if (!agent) throw new ApiError(404, 'NOT_FOUND', 'No such agent');
    if (!agent.sides.includes(existing.side)) throw new ApiError(400, 'VALIDATION_ERROR', `That agent does not work the ${existing.side.toLowerCase()} side`);
  }
  const row = await repository.updateTerritory(id, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(ring ? { polygon: ring, ...bboxOfRing(ring) } : {}),
    ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
  });
  return territoryView(row);
}

export async function listTerritories() {
  return (await repository.listTerritories({ activeOnly: false })).map(territoryView);
}

export function territoryView(row: { id: string; name: string; side: string; polygon: unknown; agentId: string; city: string | null; isActive: boolean; createdAt: Date; leadCount?: number }) {
  return { id: row.id, name: row.name, side: row.side, polygon: row.polygon as Ring, agentId: row.agentId, city: row.city, isActive: row.isActive, createdAt: row.createdAt.toISOString(), leadCount: row.leadCount ?? 0 };
}

/** The territory whose ring covers the point, for the routing port. The newest wins a tie. */
export async function territoryFor(lead: { side: string; latitude: number | null; longitude: number | null }): Promise<{ id: string; agentId: string } | null> {
  if (lead.latitude === null || lead.longitude === null) return null;
  const point = { latitude: lead.latitude, longitude: lead.longitude };
  const candidates = await repository.territoriesCovering(point, lead.side);
  const hit = candidates.find((row) => inRing(point, row.polygon as Ring));
  return hit ? { id: hit.id, agentId: hit.agentId } : null;
}

/** Assign every open, unassigned lead inside a polygon to an agent — the console's "assign from the polygon". */
export async function assignInPolygon(input: { polygon: unknown; side: 'PUBLISHER' | 'ADVERTISER'; agentId: string }, byUserId: string): Promise<{ assigned: number; ids: string[] }> {
  const ring = parseRing(input.polygon);
  if (!ring) throw new ApiError(400, 'VALIDATION_ERROR', 'Draw a polygon of at least three corners');
  const agent = await repository.findAgentBrief(input.agentId);
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'No such agent');
  const rows = await repository.findOpenInBBox(bboxOfRing(ring), { side: input.side }, PIN_CAP * 4);
  const inside = rows.filter((row) => row.latitude !== null && row.longitude !== null && !row.assignedAgentId && inRing({ latitude: row.latitude, longitude: row.longitude }, ring));
  for (const row of inside) {
    await repository.update(row.id, { assignedAgentId: input.agentId, claimedByAgentId: null, claimExpiresAt: null });
    await repository.logActivity({ leadId: row.id, actorUserId: byUserId, kind: 'NOTE', note: 'Assigned from the map' });
    await advanceStage(row.id, 'CLAIMED', { actorUserId: byUserId, note: 'assigned from the map' });
  }
  return { assigned: inside.length, ids: inside.map((row) => row.id) };
}

/* ── priority zones (D7) ───────────────────────────────────────────────── */

export type ZoneInput = { name: string; side?: 'PUBLISHER' | 'ADVERTISER' | undefined; polygon?: unknown; category?: string | undefined; topUp?: number | undefined; startsAt: Date; endsAt: Date; budgetCap?: number | null | undefined };

export async function createZone(input: ZoneInput, byUserId: string) {
  const ring = input.polygon !== undefined && input.polygon !== null ? parseRing(input.polygon) : null;
  if (input.polygon !== undefined && input.polygon !== null && !ring) throw new ApiError(400, 'VALIDATION_ERROR', 'Draw a polygon of at least three corners');
  if (!ring && !input.category?.trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'A zone is a drawn area, a category, or both');
  if (input.endsAt <= input.startsAt) throw new ApiError(400, 'VALIDATION_ERROR', 'The zone must end after it starts');
  const row = await repository.createZone({
    name: input.name,
    side: input.side ?? null,
    polygon: ring,
    ...(ring ? bboxOfRing(ring) : { south: null, west: null, north: null, east: null }),
    category: input.category?.trim() || null,
    topUp: input.topUp ?? 0,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    budgetCap: input.budgetCap ?? null,
    createdById: byUserId,
  });
  return zoneView(row);
}

export async function updateZone(id: string, patch: { name?: string | undefined; topUp?: number | undefined; startsAt?: Date | undefined; endsAt?: Date | undefined; budgetCap?: number | null | undefined; isActive?: boolean | undefined }) {
  const existing = await repository.findZone(id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'No such zone');
  const startsAt = patch.startsAt ?? existing.startsAt;
  const endsAt = patch.endsAt ?? existing.endsAt;
  if (endsAt <= startsAt) throw new ApiError(400, 'VALIDATION_ERROR', 'The zone must end after it starts');
  return zoneView(await repository.updateZone(id, patch));
}

export async function listZones() {
  return (await repository.listZones()).map(zoneView);
}

export function zoneView(row: { id: string; name: string; side: string | null; polygon: unknown; category: string | null; topUp: unknown; startsAt: Date; endsAt: Date; budgetCap: unknown; spent: unknown; isActive: boolean; createdAt: Date }) {
  return {
    id: row.id,
    name: row.name,
    side: row.side,
    polygon: (row.polygon as Ring | null) ?? null,
    category: row.category,
    topUp: money(row.topUp as never),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    budgetCap: row.budgetCap === null || row.budgetCap === undefined ? null : money(row.budgetCap as never),
    spent: money(row.spent as never),
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

async function activeZones(now: Date): Promise<ZoneRow[]> {
  const rows = await repository.listZones({ activeAt: now });
  return rows.map((row) => ({ id: row.id, side: row.side, ring: (row.polygon as Ring | null) ?? null, category: row.category, topUp: Number(row.topUp), startsAt: row.startsAt, endsAt: row.endsAt, budgetCap: row.budgetCap === null ? null : Number(row.budgetCap), spent: Number(row.spent), isActive: row.isActive, name: row.name }));
}

/** D7: the top-up on an activation inside a zone — once, under the zone's budget and the platform's monthly cap. */
export async function payPriorityTopUp(lead: { id: string; side: string; assignedAgentId: string | null; latitude: number | null; longitude: number | null; category: string | null; convertedPublisherId?: string | null; convertedAdvertiserId?: string | null; businessName?: string }, now = new Date()): Promise<{ paid: string | null; zoneId: string | null }> {
  if (!lead.assignedAgentId) return { paid: null, zoneId: null };
  const zones = await activeZones(now);
  const zone = zones.find((candidate) => zoneCovers(candidate, lead, now));
  if (!zone) return { paid: null, zoneId: null };
  // An activation is topped up once, whichever zone covers it — the incentive row is the record.
  if (await repository.priorityTopUpPaid(lead.id)) return { paid: null, zoneId: zone.id };
  const settings = (await getPlatformSettings()).leads.priority;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const spentThisMonth = await repository.priorityTopUpsSince(monthStart);
  const amount = topUpAllowed(zone, settings.topUp, settings.monthlyCap, spentThisMonth);
  if (amount <= 0) return { paid: null, zoneId: zone.id };
  try {
    const tier = (await findAgentTier(lead.assignedAgentId)) ?? '*';
    // Keyed on the account like LEAD_ACTIVATED; the note names the zone, the amount is the zone's own.
    await recordIncentiveOnce({
      agentId: lead.assignedAgentId,
      event: 'LEAD_ACTIVATED',
      tier,
      side: lead.side === 'ADVERTISER' ? 'ADVERTISER' : 'PUBLISHER',
      orderId: `priority:${zone.id}:${lead.id}`,
      amount: money(amount),
      note: `Priority zone "${zone.name}" top-up on lead ${lead.id}${lead.businessName ? `: ${lead.businessName}` : ''}`,
      notice: { partyName: lead.businessName ?? null },
    });
    await repository.addZoneSpend(zone.id, money(amount));
    return { paid: money(amount), zoneId: zone.id };
  } catch (err) {
    logger.warn('Priority top-up was not recorded', { leadId: lead.id, zoneId: zone.id, err });
    return { paid: null, zoneId: zone.id };
  }
}

/* ── claims (D3) ───────────────────────────────────────────────────────── */

export async function claimLead(leadId: string, userId: string, now = new Date()) {
  const agent = await requireAgentProfile(userId);
  const lead = await repository.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  const settings = (await getPlatformSettings()).leads.claims;
  const [open, lastLapsedAt] = await Promise.all([repository.countOpenFor(agent.id), repository.lastLapsedClaim(leadId, agent.id)]);
  const verdict = claimVerdict({ lead, agentId: agent.id, tier: agent.tier, open, caps: settings.caps, lastLapsedAt, cooldownDays: settings.cooldownDays, now });
  if (!verdict.ok) throw new ApiError(409, 'CONFLICT', verdict.reason, { reason: verdict.code, until: verdict.until?.toISOString() ?? null });
  const expiresAt = new Date(now.getTime() + settings.holdHours * HOUR_MS);
  await repository.createClaim({ leadId, agentId: agent.id, claimedAt: now, expiresAt });
  await repository.update(leadId, { assignedAgentId: agent.id, claimedByAgentId: agent.id, claimExpiresAt: expiresAt });
  await repository.logActivity({ leadId, actorUserId: userId, kind: 'NOTE', note: `Claimed for ${settings.holdHours} h` });
  await advanceStage(leadId, 'CLAIMED', { actorUserId: userId, note: 'claimed on the map' });
  await touchLead(leadId, now);
  const fresh = await repository.findById(leadId);
  return { lead: toLeadCard(fresh as unknown as LeadRow, null), claim: { expiresAt: expiresAt.toISOString(), holdHours: settings.holdHours } };
}

export async function releaseLead(leadId: string, userId: string, reason?: string, now = new Date()) {
  const agent = await requireAgentProfile(userId);
  const lead = await repository.findById(leadId);
  if (!lead) throw new ApiError(404, 'NOT_FOUND', 'No such lead');
  const holder = lead.claimedByAgentId ?? lead.assignedAgentId;
  if (holder !== agent.id) throw new ApiError(409, 'CONFLICT', 'You do not hold this lead', { reason: 'NOT_HOLDER' });
  await repository.closeOpenClaims(leadId, now, reason ?? 'released');
  await repository.update(leadId, { assignedAgentId: null, claimedByAgentId: null, claimExpiresAt: null });
  await repository.logActivity({ leadId, actorUserId: userId, kind: 'NOTE', note: `Released${reason ? `: ${reason}` : ''}` });
  const fresh = await repository.findById(leadId);
  return toLeadCard(fresh as unknown as LeadRow, null);
}

/** The hourly sweep: an unworked claim past its hold goes back to the pool; an hour before, the agent is warned. */
export async function sweepClaims(now = new Date()): Promise<{ lapsed: number; warned: number }> {
  const due = await repository.claimsExpiredBefore(now, 500);
  let lapsed = 0;
  for (const claim of due) {
    const lead = await repository.findById(claim.leadId);
    if (!lead) continue;
    // Worked since the claim — a contact, a visit — keeps it; the hold is against silence.
    const worked = lead.lastTouchedAt && lead.lastTouchedAt > claim.claimedAt && (lead.stage === 'CONTACTED' || lead.stage === 'ENGAGED' || lead.stage === 'VISIT_BOOKED' || lead.stage === 'PROPOSED');
    await repository.closeOpenClaims(claim.leadId, now, worked ? 'worked — hold ended' : 'lapsed');
    if (worked) {
      await repository.update(claim.leadId, { claimedByAgentId: null, claimExpiresAt: null });
      continue;
    }
    if (lead.claimedByAgentId === claim.agentId) {
      await repository.update(claim.leadId, { assignedAgentId: null, claimedByAgentId: null, claimExpiresAt: null });
      await repository.logActivity({ leadId: claim.leadId, actorUserId: null, kind: 'NOTE', note: 'Claim lapsed — back in the pool' });
      lapsed += 1;
    }
  }
  const soon = await repository.claimsExpiringBetween(now, new Date(now.getTime() + HOUR_MS), 500);
  let warned = 0;
  for (const claim of soon) {
    const lead = await repository.findById(claim.leadId);
    if (!lead || lead.claimedByAgentId !== claim.agentId || lead.lastTouchedAt && lead.lastTouchedAt > claim.claimedAt) continue;
    const agent = await repository.findAgentBrief(claim.agentId);
    if (!agent) continue;
    if (!(await once(`claim-lapsing:${claim.id}`, 6 * 3600))) continue;
    const minutes = String(Math.max(1, Math.round((claim.expiresAt.getTime() - now.getTime()) / 60000)));
    await notify('LEAD_CLAIM_LAPSING', agent.userId, { businessName: lead.businessName, minutes, deepLink: `adx://lead/${lead.id}` }, { type: 'SYSTEM', inApp: { type: 'SYSTEM', title: 'Your claim lapses soon', subtitle: lead.businessName, message: `Back to the pool in ${minutes} min — log a contact to keep it.`, relatedType: 'LEAD', relatedId: lead.id } }).catch((err) => logger.warn('Claim-lapsing alert not sent', { err }));
    warned += 1;
  }
  return { lapsed, warned };
}

/* ── alerts ────────────────────────────────────────────────────────────── */

export const NEARBY_HOT_KM = 1;

/** A hot lead appeared (or warmed up) within a kilometre of an agent of the side with a fix today — one push each. */
export async function alertNearbyHot(leadId: string, now = new Date()): Promise<number> {
  const lead = await repository.findById(leadId);
  if (!lead || lead.temperature !== 'HOT' || lead.latitude === null || lead.longitude === null) return 0;
  if (lead.assignedAgentId || (lead.claimedByAgentId && lead.claimExpiresAt && lead.claimExpiresAt > now)) return 0;
  const candidates = await repository.candidateAgents(lead.side, lead.cityId);
  let sent = 0;
  for (const agent of candidates) {
    const fix = await positionOf(agent.id);
    if (!fix || fix.at.getTime() < now.getTime() - DAY_MS) continue;
    const metres = distanceM({ latitude: lead.latitude, longitude: lead.longitude }, fix);
    if (metres === null || metres > NEARBY_HOT_KM * 1000) continue;
    if (!(await once(`nearby-hot:${lead.id}:${agent.id}`, 7 * 24 * 3600))) continue;
    await notify('LEAD_NEARBY_HOT', agent.userId, { businessName: lead.businessName, metres: String(metres), deepLink: `adx://lead/${lead.id}` }, { type: 'SYSTEM', inApp: { type: 'SYSTEM', title: 'A hot lead near you', subtitle: lead.businessName, message: `${metres} m away and nobody holds it yet.`, relatedType: 'LEAD', relatedId: lead.id } }).catch((err) => logger.warn('Nearby-hot alert not sent', { err }));
    sent += 1;
  }
  return sent;
}

/** The agent holding a lead is told when the lead opened their link (LH7 raises it). */
export async function alertLinkOpened(leadId: string): Promise<boolean> {
  const lead = await repository.findById(leadId);
  const holder = lead?.assignedAgentId ?? lead?.claimedByAgentId ?? null;
  if (!lead || !holder) return false;
  const agent = await repository.findAgentBrief(holder);
  if (!agent) return false;
  if (!(await once(`link-opened:${lead.id}`, 3600))) return false;
  await notify('LEAD_LINK_OPENED', agent.userId, { businessName: lead.businessName, deepLink: `adx://lead/${lead.id}` }, { type: 'SYSTEM', inApp: { type: 'SYSTEM', title: 'They opened your link', subtitle: lead.businessName, message: 'A good time to call.', relatedType: 'LEAD', relatedId: lead.id } }).catch((err) => logger.warn('Link-opened alert not sent', { err }));
  return true;
}

/** LT-1's last fix, through the same port the routing uses. */
let positionOf: (agentId: string) => Promise<{ latitude: number; longitude: number; at: Date } | null> = async () => null;
export function registerMapPositionPort(port: (agentId: string) => Promise<{ latitude: number; longitude: number; at: Date } | null>): void {
  positionOf = port;
}

// The territory port and the priority top-up ride the lots' own doors.
registerTerritoryRouter(async (lead) => {
  const hit = await territoryFor(lead);
  return hit ? { agentId: hit.agentId, territoryId: hit.id } : null;
});
registerActivationHook(async (lead) => {
  await payPriorityTopUp(lead);
});
