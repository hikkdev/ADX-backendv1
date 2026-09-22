import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { prismaLeadsRepository as repository } from '../prisma-leads.repository';
import { importLeads } from '../leads.service';
import { routeLead } from '../routing.service';
import type { ImportLeadRow } from '../leads.schema';
import { googlePlacesFeed } from './google-places.feed';
import { gstFeed, indiamartFeed, justdialFeed, mcaFeed, reraFeed } from './directory.feeds';
import type { FeedCandidate, FeedSearch, LeadFeed } from './feed.port';

/**
 * LH3 (D4): the feeds as ops runs them. A run asks one adapter for
 * candidates in a city or a polygon for a category and a side, drops
 * the ones ADX already holds (by the provider's own id), hands the rest
 * to the importer — the same per-row report the paste gets, with the
 * geocoding and the dedup — and records what came of it as a `LeadFeedRun`.
 * The source's daily quota caps it; the terms confirmation gates every
 * partner feed; Google Places rides the maps key.
 */

export const FEEDS: readonly LeadFeed[] = [googlePlacesFeed, justdialFeed, indiamartFeed, mcaFeed, gstFeed, reraFeed];

export const MAX_RUN = 200;

export function feedByKey(key: string): LeadFeed | null {
  return FEEDS.find((feed) => feed.key === key) ?? null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Midnight IST of the day `now` sits in — the quota's day. */
export function istDayStart(now: Date): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

export type FeedStatus = {
  key: string;
  label: string;
  needs: string;
  configured: boolean;
  reason: string | null;
  source: { id: string; quality: number; quotaPerDay: number | null; termsAcceptedAt: string | null; isActive: boolean; usedToday: number } | null;
  /** True when a run would go through right now. */
  ready: boolean;
};

export async function feedsStatus(now = new Date()): Promise<FeedStatus[]> {
  const sources = await repository.listSources();
  const out: FeedStatus[] = [];
  for (const feed of FEEDS) {
    const source = sources.find((row) => row.key === feed.key) ?? null;
    const readiness = await feed.configured();
    const usedToday = source ? await repository.countCreatedForSourceSince(source.id, istDayStart(now)) : 0;
    const termsOk = feed.key === 'google-places' || Boolean(source?.termsAcceptedAt);
    out.push({
      key: feed.key,
      label: feed.label,
      needs: feed.needs,
      configured: readiness.ok,
      reason: readiness.ok ? null : readiness.reason,
      source: source ? { id: source.id, quality: Number(source.quality), quotaPerDay: source.quotaPerDay, termsAcceptedAt: source.termsAcceptedAt?.toISOString() ?? null, isActive: source.isActive, usedToday } : null,
      ready: readiness.ok && Boolean(source?.isActive) && termsOk && (source?.quotaPerDay === null || source?.quotaPerDay === undefined || usedToday < source.quotaPerDay),
    });
  }
  return out;
}

/** A directory's row as the importer's row. */
export function rowOf(candidate: FeedCandidate, side: FeedSearch['side']): ImportLeadRow & { externalKey: string } {
  return {
    side,
    businessName: candidate.businessName.slice(0, 160),
    ...(candidate.category ? { category: candidate.category.slice(0, 60) } : {}),
    ...(candidate.contactName ? { contactName: candidate.contactName.slice(0, 120) } : {}),
    ...(candidate.phone ? { phone: candidate.phone.slice(0, 20) } : {}),
    ...(candidate.email ? { email: candidate.email.slice(0, 160) } : {}),
    ...(candidate.address ? { address: candidate.address.slice(0, 300) } : {}),
    ...(candidate.locality ? { locality: candidate.locality.slice(0, 120) } : {}),
    ...(candidate.city ? { city: candidate.city.slice(0, 80) } : {}),
    ...(candidate.latitude !== null && candidate.latitude !== undefined ? { latitude: candidate.latitude } : {}),
    ...(candidate.longitude !== null && candidate.longitude !== undefined ? { longitude: candidate.longitude } : {}),
    externalKey: candidate.externalKey,
  };
}

export async function runFeed(key: string, input: FeedSearch, requestedById: string | null, now = new Date()) {
  const feed = feedByKey(key);
  if (!feed) throw new ApiError(404, 'NOT_FOUND', `No feed called ${key}`);
  const source = await repository.findSourceByKey(key);
  if (!source) throw new ApiError(404, 'NOT_FOUND', `No source row for ${key}`);
  const readiness = await feed.configured();
  if (!readiness.ok) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', readiness.reason);
  if (!source.isActive) throw new ApiError(409, 'CONFLICT', `${feed.label} is switched off under Settings › Leads scoring › Sources`, { reason: 'SOURCE_OFF' });
  if (feed.key !== 'google-places' && !source.termsAcceptedAt) {
    throw new ApiError(409, 'CONFLICT', `${feed.label}'s terms have not been confirmed — confirm them on the source before running it`, { reason: 'TERMS_NOT_CONFIRMED' });
  }
  const usedToday = await repository.countCreatedForSourceSince(source.id, istDayStart(now));
  const room = source.quotaPerDay === null ? MAX_RUN : Math.max(0, source.quotaPerDay - usedToday);
  if (room === 0) {
    await repository.createFeedRun({ sourceId: source.id, requestedById, side: input.side, category: input.category, city: input.city ?? null, polygon: input.polygon ?? null, limit: input.limit, status: 'QUOTA', finishedAt: now, error: `Daily quota of ${source.quotaPerDay} already used` });
    throw new ApiError(429, 'TOO_MANY_REQUESTS', `${feed.label} has used its ${source.quotaPerDay} for today`, { reason: 'QUOTA_EXHAUSTED', usedToday });
  }
  const limit = Math.min(input.limit, MAX_RUN, room);
  const run = await repository.createFeedRun({ sourceId: source.id, requestedById, side: input.side, category: input.category, city: input.city ?? null, polygon: input.polygon ?? null, limit, status: 'RUNNING' });
  try {
    const candidates = await feed.search({ ...input, limit });
    const keys = candidates.map((row) => row.externalKey);
    const known = new Set((await repository.findByExternalKeys(keys)).map((row) => row.externalKey));
    const fresh = candidates.filter((row) => !known.has(row.externalKey));
    const result = fresh.length > 0 ? await importLeads(source.key, fresh.map((row) => rowOf(row, input.side)), requestedById, { sourceKind: 'FEED', feedRunId: run.id }) : { imported: 0, skipped: 0, warnings: 0, ids: [] as string[], report: [] };
    const alreadyHeld = candidates.length - fresh.length;
    const finished = await repository.updateFeedRun(run.id, {
      status: 'DONE',
      candidates: candidates.length,
      imported: result.imported,
      skipped: result.skipped + alreadyHeld,
      warnings: result.warnings,
      report: { rows: result.report, alreadyHeld },
      finishedAt: new Date(),
    });
    // A directory's rows route like any other new lead: the nearest agent of the side with room, else the pool.
    for (const id of result.ids) await routeLead(id).catch((err) => logger.warn('Feed lead not routed', { leadId: id, err }));
    return { ...feedRunView(finished), ids: result.ids };
  } catch (error) {
    await repository.updateFeedRun(run.id, { status: 'FAILED', error: error instanceof Error ? error.message : String(error), finishedAt: new Date() });
    throw error;
  }
}

export function feedRunView(run: { id: string; sourceId: string; requestedById: string | null; side: string; category: string; city: string | null; polygon: unknown; limit: number; status: string; candidates: number; imported: number; skipped: number; warnings: number; report: unknown; error: string | null; startedAt: Date; finishedAt: Date | null; source?: { key: string; label: string } | null }) {
  return {
    id: run.id,
    sourceId: run.sourceId,
    sourceKey: run.source?.key ?? null,
    sourceLabel: run.source?.label ?? null,
    requestedById: run.requestedById,
    side: run.side,
    category: run.category,
    city: run.city,
    polygon: run.polygon ?? null,
    limit: run.limit,
    status: run.status,
    candidates: run.candidates,
    imported: run.imported,
    skipped: run.skipped,
    warnings: run.warnings,
    report: run.report ?? null,
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export async function listFeedRuns(sourceKey?: string) {
  const source = sourceKey ? await repository.findSourceByKey(sourceKey) : null;
  if (sourceKey && !source) throw new ApiError(404, 'NOT_FOUND', `No source called ${sourceKey}`);
  return (await repository.listFeedRuns(source?.id ?? null, 50)).map(feedRunView);
}

export async function getFeedRun(runId: string) {
  const run = await repository.findFeedRun(runId);
  if (!run) throw new ApiError(404, 'NOT_FOUND', 'No such run');
  return feedRunView(run);
}

export { DAY_MS };
