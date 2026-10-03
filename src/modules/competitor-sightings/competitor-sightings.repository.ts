import type { CompetitorSighting, Prisma } from '../../shared/database';

/**
 * VA-2: a competitor's hoarding as an agent filed it, and the desk's reads.
 */

export type SightingRow = CompetitorSighting & {
  agent: { id: string; displayId: string | null; user: { name: string | null } };
};

export type NewSighting = {
  agentId: string;
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
  cityId: string | null;
  capturedAt: Date;
};

export type SightingFilter = {
  q?: string | undefined;
  brand?: string | undefined;
  format?: string | undefined;
  agentId?: string | undefined;
  city?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  analysed?: boolean | undefined;
  page: number;
  pageSize: number;
};

export interface CompetitorSightingsRepository {
  create(data: NewSighting): Promise<SightingRow>;
  findById(id: string): Promise<SightingRow | null>;
  list(filter: SightingFilter): Promise<{ items: SightingRow[]; total: number; counts: Record<string, number> }>;
  /** Every row, oldest first — the export. Bounded by the caller's own sense; this is the corpus, not a page. */
  listAll(filter: Pick<SightingFilter, 'from' | 'to' | 'brand' | 'format' | 'city'>): Promise<SightingRow[]>;
  recordAnalysis(id: string, analysis: Prisma.InputJsonValue, at: Date): Promise<SightingRow>;
  /** The brands seen, most often first — the desk's filter chips. */
  brands(): Promise<{ brand: string; count: number }[]>;
}
