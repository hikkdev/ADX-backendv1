import type { Request } from 'express';
import { z } from 'zod';
import { AiUnavailableError, complete } from '../../shared/ai';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { toListPage } from '../../shared/pagination';
import { requireAgentProfile } from '../agents';
import { findUploadedFile, isModelReadableImage, readImageForModel } from '../uploads';
import { prismaCompetitorSightingsRepository as repository } from './prisma-competitor-sightings.repository';
import { SIGHTING_FORMATS, type CreateSightingInput, type ListSightingsQuery } from './competitor-sightings.schema';
import type { SightingRow } from './competitor-sightings.repository';

/**
 * VA-2 (23 Sep 2026): competitors' hoardings, photographed by our agents.
 *
 * The owner: "Our agents can also go around taking photos of hoardings of
 * our competitors and we can collect that for analysis and training
 * purposes." So an agent who passes a competitor's hoarding photographs it
 * with the ADX camera — the location stamp on, so where and when are on the
 * picture itself — and files it with whatever they can read off it: the
 * brand, the category, what kind of surface it is. The desk lists them,
 * asks the vision model what it sees, and exports the lot as a corpus.
 *
 * What is collected is public advertising in a public place, photographed
 * by our own people: no subject's consent is at issue the way it is for an
 * advertiser's own artwork (which is theirs, and a training clause in their
 * agreement is the owner's to add — see OPEN-TASKS). The photo is still
 * stored privately: it is ADX's material, not a public gallery.
 */

export type SightingView = {
  id: string;
  agent: { id: string; displayId: string | null; name: string | null };
  photoFileId: string;
  photoUrl: string;
  brand: string | null;
  category: string | null;
  format: string | null;
  note: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  city: string | null;
  capturedAt: string;
  analysis: SightingAnalysis | null;
  analysedAt: string | null;
  createdAt: string;
};

export function toSightingView(row: SightingRow): SightingView {
  return {
    id: row.id,
    agent: { id: row.agent.id, displayId: row.agent.displayId, name: row.agent.user.name },
    photoFileId: row.photoFileId,
    photoUrl: row.photoUrl,
    brand: row.brand,
    category: row.category,
    format: row.format,
    note: row.note,
    latitude: row.latitude,
    longitude: row.longitude,
    address: row.address,
    city: row.city,
    capturedAt: row.capturedAt.toISOString(),
    analysis: row.analysis ? (row.analysis as SightingAnalysis) : null,
    analysedAt: row.analysedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Files a sighting. The photo must be the agent's own upload; where and when
 * default to the stamp the ADX camera put on it, so an agent who typed
 * nothing but the brand still files a placed, dated sighting.
 */
export async function logSighting(userId: string, input: CreateSightingInput, req?: Request): Promise<SightingView> {
  const agent = await requireAgentProfile(userId);
  const file = await findUploadedFile(input.photoFileId);
  if (!file || file.userId !== userId) throw new ApiError(404, 'NOT_FOUND', 'That photo is not one of yours');
  if (!isModelReadableImage(file.mimeType)) throw new ApiError(400, 'VALIDATION_ERROR', 'A sighting is a photograph');

  const row = await repository.create({
    agentId: agent.id,
    photoFileId: file.id,
    photoUrl: file.url,
    brand: input.brand?.trim() || null,
    category: input.category?.trim() || null,
    format: input.format ?? null,
    note: input.note?.trim() || null,
    latitude: input.latitude ?? file.latitude ?? null,
    longitude: input.longitude ?? file.longitude ?? null,
    address: input.address?.trim() || null,
    city: input.city?.trim() || agent.city || null,
    cityId: agent.cityId ?? null,
    capturedAt: input.capturedAt ?? file.takenAt ?? new Date(),
  });

  await logActivity(userId, 'COMPETITOR_SIGHTING_LOGGED', {
    req,
    targetType: 'CompetitorSighting',
    targetId: row.id,
    module: 'competitor-sightings',
    metadata: { brand: row.brand, format: row.format, stamped: file.geoStamped },
  });
  return toSightingView(row);
}

export async function listSightings(query: ListSightingsQuery) {
  const { items, total, counts } = await repository.list({
    q: query.q,
    brand: query.brand,
    format: query.format,
    agentId: query.agentId,
    city: query.city,
    from: query.from,
    to: query.to,
    analysed: query.analysed,
    page: query.page,
    pageSize: query.pageSize,
  });
  return toListPage(items.map(toSightingView), total, counts, query);
}

export async function getSighting(id: string): Promise<SightingView> {
  const row = await repository.findById(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Sighting not found');
  return toSightingView(row);
}

export const sightingBrands = () => repository.brands();

/* ------------------------------------------------------------------ */
/* The vision pass                                                     */
/* ------------------------------------------------------------------ */

export const SIGHTING_ANALYSIS_SYSTEM = [
  'You describe out-of-home advertising photographed in the street in India, for a marketplace building a picture of',
  'who advertises where. You answer with one JSON object and nothing else, in this exact shape:',
  '{"brand":"the advertiser or brand named, or null","category":"what is advertised, a few words","format":"HOARDING|WALL|BUS_SHELTER|VEHICLE|DIGITAL_SCREEN|SHOP_FRONT|BANNER|OTHER",',
  ' "estimatedSize":"the printed area in feet, wide by tall, as your best estimate, or null","illuminated":true|false|null,',
  ' "condition":"NEW|GOOD|WORN|DAMAGED|UNKNOWN","text":"the legible text on the advertisement, verbatim, or null",',
  ' "summary":"one sentence for the desk","confidence":0.0}',
  'Never invent a brand or text you cannot read in the picture; say null. Estimate size from context (people, vehicles, doorways).',
].join(' ');

const analysisSchema = z.object({
  brand: z.string().trim().max(80).nullable().default(null),
  category: z.string().trim().max(120).nullable().default(null),
  format: z.enum(SIGHTING_FORMATS).nullable().default(null),
  estimatedSize: z.string().trim().max(60).nullable().default(null),
  illuminated: z.boolean().nullable().default(null),
  condition: z.enum(['NEW', 'GOOD', 'WORN', 'DAMAGED', 'UNKNOWN']).default('UNKNOWN'),
  text: z.string().trim().max(1000).nullable().default(null),
  summary: z.string().trim().min(1).max(600),
  confidence: z.number().min(0).max(1),
});
export type SightingAnalysis = z.infer<typeof analysisSchema> & { provider: string; model: string; perceptualHash: string };

export function parseSightingAnalysis(text: string): z.infer<typeof analysisSchema> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the answer');
  return analysisSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/**
 * The desk asks the model what it sees. The answer is kept on the row, and
 * the brand, category and format the agent left blank are filled from it —
 * never overwritten: what a person read off a hoarding beats a model's guess.
 */
export async function analyseSighting(id: string, actor: { userId: string; req?: Request }): Promise<SightingView> {
  const row = await repository.findById(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Sighting not found');

  const image = await readImageForModel(row.photoUrl);
  let answer: z.infer<typeof analysisSchema>;
  let provider: string;
  let model: string;
  try {
    const result = await complete({
      system: SIGHTING_ANALYSIS_SYSTEM,
      prompt: [row.brand ? `The agent read the brand as: ${row.brand}` : null, row.category ? `The agent filed the category as: ${row.category}` : null, row.address ? `Photographed at: ${row.address}` : null, 'Describe the advertisement in the picture and answer with the JSON object only.']
        .filter((line): line is string => line !== null)
        .join('\n'),
      maxTokens: 500,
      temperature: 0.1,
      images: [{ mimeType: image.mimeType, base64: image.base64 }],
    });
    provider = result.provider;
    model = result.model;
    answer = parseSightingAnalysis(result.text);
  } catch (cause) {
    if (cause instanceof AiUnavailableError) throw new ApiError(503, 'AI_UNAVAILABLE', cause.message);
    throw new ApiError(502, 'AI_FAILED', (cause as Error).message);
  }

  const analysis: SightingAnalysis = { ...answer, provider, model, perceptualHash: image.perceptualHash };
  const updated = await repository.recordAnalysis(id, analysis, new Date());
  await logActivity(actor.userId, 'COMPETITOR_SIGHTING_ANALYSED', {
    req: actor.req,
    targetType: 'CompetitorSighting',
    targetId: id,
    module: 'competitor-sightings',
    metadata: { provider, model, brand: answer.brand, format: answer.format, confidence: answer.confidence },
  });
  return toSightingView(updated);
}

/* ------------------------------------------------------------------ */
/* The corpus                                                          */
/* ------------------------------------------------------------------ */

const CSV_COLUMNS = ['id', 'capturedAt', 'agentDisplayId', 'brand', 'category', 'format', 'latitude', 'longitude', 'address', 'city', 'photoUrl', 'note', 'aiBrand', 'aiCategory', 'aiFormat', 'aiEstimatedSize', 'aiCondition', 'aiText', 'aiConfidence'] as const;

const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** One row per sighting, the agent's reading beside the model's, for whoever trains on it. */
export function sightingsToCsv(rows: SightingView[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    const ai = row.analysis;
    lines.push(
      [row.id, row.capturedAt, row.agent.displayId, row.brand, row.category, row.format, row.latitude, row.longitude, row.address, row.city, row.photoUrl, row.note, ai?.brand ?? null, ai?.category ?? null, ai?.format ?? null, ai?.estimatedSize ?? null, ai?.condition ?? null, ai?.text ?? null, ai?.confidence ?? null]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function exportSightings(filter: { format: 'csv' | 'jsonl'; brand?: string | undefined; city?: string | undefined; from?: Date | undefined; to?: Date | undefined }): Promise<{ body: string; contentType: string; filename: string }> {
  const rows = (await repository.listAll({ brand: filter.brand, city: filter.city, from: filter.from, to: filter.to })).map(toSightingView);
  const stamp = new Date().toISOString().slice(0, 10);
  if (filter.format === 'jsonl') {
    return { body: rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), contentType: 'application/x-ndjson', filename: `competitor-sightings-${stamp}.jsonl` };
  }
  return { body: sightingsToCsv(rows), contentType: 'text/csv; charset=utf-8', filename: `competitor-sightings-${stamp}.csv` };
}
