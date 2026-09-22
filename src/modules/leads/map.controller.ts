import type { Request, Response } from 'express';
import { z } from 'zod';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { LEAD_SIDES, LEAD_TEMPERATURES } from './leads.schema';
import { parseBBox } from './map.rules';
import {
  assignInPolygon,
  claimLead,
  createTerritory,
  createZone,
  heatView,
  listTerritories,
  listZones,
  mapView,
  releaseLead,
  territoryView,
  updateTerritory,
  updateZone,
  zoneView,
} from './map.service';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';

/**
 * LH5: the map's doors — the viewport, the heat, the claims, the
 * territories, the priority zones.
 */

const parse = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

const ring = z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(3).max(500);
const flag = z.preprocess((value) => (value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : value), z.boolean());

/* ── the viewport ──────────────────────────────────────────────────────── */

const mapQuerySchema = z.object({
  bbox: z.string().min(7),
  side: z.enum(LEAD_SIDES).optional(),
  temperature: z.enum(LEAD_TEMPERATURES).optional(),
  priority: flag.optional(),
  claimed: z.enum(['MINE', 'OPEN', 'ANY']).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  pins: flag.optional(),
});

export async function mapHandler(req: Request, res: Response): Promise<void> {
  const query = parse(mapQuerySchema, req.query);
  const bbox = parseBBox(query.bbox);
  if (!bbox) throw new ApiError(400, 'VALIDATION_ERROR', 'bbox is south,west,north,east');
  const isAdmin = req.user!.roles.includes('ADMIN');
  const data = await mapView({ bbox, side: query.side, temperature: query.temperature, priority: query.priority, claimed: query.claimed, category: query.category, pins: isAdmin ? query.pins : false }, { userId: req.user!.sub, isAdmin });
  res.json({ success: true, data });
}

const heatQuerySchema = z.object({ bbox: z.string().min(7), side: z.enum(LEAD_SIDES).optional() });

export async function heatHandler(req: Request, res: Response): Promise<void> {
  const query = parse(heatQuerySchema, req.query);
  const bbox = parseBBox(query.bbox);
  if (!bbox) throw new ApiError(400, 'VALIDATION_ERROR', 'bbox is south,west,north,east');
  res.json({ success: true, data: await heatView(bbox, query.side) });
}

/* ── claims (D3) ───────────────────────────────────────────────────────── */

export async function claimLeadHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await claimLead(req.params['leadId'] as string, req.user!.sub) });
}

const releaseSchema = z.object({ reason: z.string().trim().max(200).optional() });

export async function releaseLeadHandler(req: Request, res: Response): Promise<void> {
  const body = parse(releaseSchema, req.body ?? {});
  res.json({ success: true, data: await releaseLead(req.params['leadId'] as string, req.user!.sub, body.reason) });
}

const assignSchema = z.object({ polygon: ring, side: z.enum(LEAD_SIDES), agentId: z.string().min(1) });

export async function assignInPolygonHandler(req: Request, res: Response): Promise<void> {
  const body = parse(assignSchema, req.body);
  const result = await assignInPolygon(body, req.user!.sub);
  await logActivity(req.user!.sub, 'LEADS_ASSIGNED_FROM_MAP', { req, module: 'leads', targetType: 'AgentProfile', targetId: body.agentId, metadata: { side: body.side, corners: body.polygon.length, assigned: result.assigned, leadIds: result.ids } });
  res.json({ success: true, data: result });
}

/* ── territories (D8) ──────────────────────────────────────────────────── */

const createTerritorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  side: z.enum(LEAD_SIDES),
  polygon: ring,
  agentId: z.string().min(1),
  city: z.string().trim().min(1).max(80).optional(),
});

const patchTerritorySchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    polygon: ring.optional(),
    agentId: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

const TERRITORY_FIELDS = ['name', 'polygon', 'agentId', 'isActive'] as const;

export async function listTerritoriesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listTerritories() });
}

export async function createTerritoryHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createTerritorySchema, req.body);
  const territory = await createTerritory(body, req.user!.sub);
  await logActivity(req.user!.sub, 'LEAD_TERRITORY_CREATED', { req, module: 'leads', targetType: 'Territory', targetId: territory.id, metadata: { name: territory.name, side: territory.side, agentId: territory.agentId, corners: body.polygon.length } });
  res.status(201).json({ success: true, data: territory });
}

export async function patchTerritoryHandler(req: Request, res: Response): Promise<void> {
  const body = parse(patchTerritorySchema, req.body);
  const id = req.params['territoryId'] as string;
  const before = await repository.findTerritory(id);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'No such territory');
  const territory = await updateTerritory(id, body);
  await logActivity(req.user!.sub, 'LEAD_TERRITORY_UPDATED', { req, module: 'leads', targetType: 'Territory', targetId: id, diff: auditDiff(territoryView(before), territory, TERRITORY_FIELDS) });
  res.json({ success: true, data: territory });
}

/* ── priority zones (D7) ───────────────────────────────────────────────── */

const isoDate = z.coerce.date();
const rupees = z.number().min(0).max(1_000_000);

const createZoneSchema = z.object({
  name: z.string().trim().min(2).max(80),
  side: z.enum(LEAD_SIDES).optional(),
  polygon: ring.optional(),
  category: z.string().trim().min(1).max(60).optional(),
  topUp: rupees.optional(),
  startsAt: isoDate,
  endsAt: isoDate,
  budgetCap: rupees.nullable().optional(),
});

const patchZoneSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    topUp: rupees.optional(),
    startsAt: isoDate.optional(),
    endsAt: isoDate.optional(),
    budgetCap: rupees.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

const ZONE_FIELDS = ['name', 'topUp', 'startsAt', 'endsAt', 'budgetCap', 'isActive'] as const;

export async function listZonesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listZones() });
}

export async function createZoneHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createZoneSchema, req.body);
  const zone = await createZone(body, req.user!.sub);
  await logActivity(req.user!.sub, 'LEAD_PRIORITY_ZONE_CREATED', { req, module: 'leads', targetType: 'PriorityZone', targetId: zone.id, metadata: { name: zone.name, side: zone.side, category: zone.category, topUp: zone.topUp, startsAt: zone.startsAt, endsAt: zone.endsAt, budgetCap: zone.budgetCap } });
  res.status(201).json({ success: true, data: zone });
}

export async function patchZoneHandler(req: Request, res: Response): Promise<void> {
  const body = parse(patchZoneSchema, req.body);
  const id = req.params['zoneId'] as string;
  const before = await repository.findZone(id);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'No such zone');
  const zone = await updateZone(id, body);
  await logActivity(req.user!.sub, 'LEAD_PRIORITY_ZONE_UPDATED', { req, module: 'leads', targetType: 'PriorityZone', targetId: id, diff: auditDiff(zoneView(before), zone, ZONE_FIELDS) });
  res.json({ success: true, data: zone });
}
