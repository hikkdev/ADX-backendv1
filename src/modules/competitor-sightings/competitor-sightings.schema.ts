import { z } from 'zod';
import { MAX_LIST_PAGE_SIZE } from '../../shared/pagination';

/** What a hoarding physically is. Fixed so the desk can filter and a model can be asked in the same words. */
export const SIGHTING_FORMATS = ['HOARDING', 'WALL', 'BUS_SHELTER', 'VEHICLE', 'DIGITAL_SCREEN', 'SHOP_FRONT', 'BANNER', 'OTHER'] as const;
export type SightingFormat = (typeof SIGHTING_FORMATS)[number];

const text = (max: number) => z.string().trim().max(max);

/** `POST /competitor-sightings` — an agent files what they photographed. */
export const createSightingSchema = z.object({
  /** The stamped photo, already uploaded under COMPETITOR_CAPTURE. */
  photoFileId: z.string().trim().min(1).max(64),
  brand: text(80).optional(),
  category: text(80).optional(),
  format: z.enum(SIGHTING_FORMATS).optional(),
  note: text(500).optional(),
  /** Where it stands. Omitted, the photo's own stamp is used. */
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  address: text(200).optional(),
  city: text(80).optional(),
  /** When it was taken. Omitted, the photo's own stamp, else now. */
  capturedAt: z.coerce.date().optional(),
});
export type CreateSightingInput = z.infer<typeof createSightingSchema>;

/** `GET /competitor-sightings` — the desk's list, on the list contract. */
export const listSightingsQuerySchema = z.object({
  q: text(80).optional(),
  brand: text(80).optional(),
  format: z.enum(SIGHTING_FORMATS).optional(),
  agentId: z.string().trim().max(64).optional(),
  city: text(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  analysed: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(50),
});
export type ListSightingsQuery = z.infer<typeof listSightingsQuerySchema>;

/** `GET /competitor-sightings/export` — the corpus, as CSV or JSON lines. */
export const exportSightingsQuerySchema = z.object({
  format: z.enum(['csv', 'jsonl']).default('csv'),
  brand: text(80).optional(),
  city: text(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
