import { logger } from '../../shared/logging';
import { money } from '../../shared/money';
import { getPlatformSettings } from '../app-config';
import type { LeadScoringPolicy } from '../../shared/lead-scoring';
import { prismaLeadsRepository as repository } from './prisma-leads.repository';
import type { LeadForScoring } from './leads.repository';
import { computeScore, learnedQuality, temperatureChangeNote, type ScoreReason, type ScoreResult } from './scoring.rules';

/**
 * LH1: the score, kept fresh.
 *
 * Recomputed on every touch (`touchLead`) and once a night over every open
 * lead (`recomputeAll`), from the policy under `leads.scoring`. A change of
 * temperature is an activity row the agent reads ("Warmed up to Hot:
 * opened the invite link"); the first computation writes no row. The
 * source's quality is learned nightly from its own 90-day conversions.
 */

const INTENT_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** LH5 hooks here: a lead that just became HOT is announced to the agents near it. Registered from the module's index. */
export type TemperatureHook = (leadId: string, to: 'HOT' | 'WARM' | 'COLD', from: 'HOT' | 'WARM' | 'COLD' | null) => Promise<void>;
const temperatureHooks: TemperatureHook[] = [];
export function registerTemperatureHook(hook: TemperatureHook): void {
  temperatureHooks.push(hook);
}

export async function scoringPolicy(): Promise<LeadScoringPolicy> {
  return (await getPlatformSettings()).leads.scoring;
}

/** What a lead is worth to ADX: a publisher's wall at the comparables' median × 30 days; an advertiser's likely first campaign. */
async function estimateValue(lead: LeadForScoring, policy: LeadScoringPolicy, now: Date): Promise<string | null> {
  const point = lead.latitude !== null && lead.longitude !== null ? { latitude: lead.latitude, longitude: lead.longitude } : null;
  if (lead.side === 'PUBLISHER') {
    if (!point) return null;
    const rate = await repository.medianLiveRateNear(point, policy.fit.localityRadiusM);
    return rate === null ? null : money(Number(rate) * 30);
  }
  return repository.averageCampaignBudget(lead.cityId, new Date(now.getTime() - INTENT_WINDOW_DAYS * DAY_MS));
}

export async function scoreOf(lead: LeadForScoring, policy: LeadScoringPolicy, now: Date): Promise<ScoreResult> {
  const point = lead.latitude !== null && lead.longitude !== null ? { latitude: lead.latitude, longitude: lead.longitude } : null;
  const liveListingsNearby = point ? await repository.countLiveListingsNear(point, policy.fit.localityRadiusM).catch(() => null) : null;
  return computeScore(
    {
      side: lead.side,
      category: lead.category,
      importance: lead.importance,
      createdAt: lead.createdAt,
      lastTouchedAt: lead.lastTouchedAt,
      agentFlaggedHotAt: lead.agentFlaggedHotAt,
      source: lead.sourceRef ? { quality: Number(lead.sourceRef.quality), kind: lead.sourceRef.kind } : null,
      activity: lead.activity.map((row) => ({ kind: row.kind, at: row.createdAt })),
      liveListingsNearby,
    },
    policy,
    now,
  );
}

/**
 * Recompute one lead and write what moved. Answers the result, or null for
 * a lead that no longer exists. A closed lead keeps its last score.
 */
export async function recomputeLead(leadId: string, now = new Date(), policy?: LeadScoringPolicy): Promise<ScoreResult | null> {
  const lead = await repository.findForScoring(leadId, new Date(now.getTime() - INTENT_WINDOW_DAYS * DAY_MS));
  if (!lead) return null;
  const effective = policy ?? (await scoringPolicy());
  const result = await scoreOf(lead, effective, now);
  const estimatedValue = await estimateValue(lead, effective, now).catch(() => null);
  const previous = lead.temperature;
  // LH2: the first computation is the SOURCED → SCORED move.
  const scoredNow = lead.stage === 'SOURCED';
  await repository.update(leadId, {
    score: result.score,
    temperature: result.temperature,
    scoreReasons: result.reasons,
    scoreComputedAt: now,
    ...(estimatedValue !== null ? { estimatedValue } : {}),
    ...(scoredNow ? { stage: 'SCORED', stageChangedAt: now } : {}),
  });
  if (previous !== result.temperature && previous !== null) {
    await repository.logActivity({ leadId, actorUserId: null, kind: 'TEMPERATURE_CHANGED', note: temperatureChangeNote(previous, result.temperature, result.reasons) });
  }
  if (scoredNow) await repository.logActivity({ leadId, actorUserId: null, kind: 'STAGE_CHANGED', note: `SOURCED → SCORED — ${result.temperature.toLowerCase()} at ${result.score}` });
  if (previous !== result.temperature) {
    for (const hook of temperatureHooks) await hook(leadId, result.temperature, previous as 'HOT' | 'WARM' | 'COLD' | null).catch((err) => logger.warn('Temperature hook failed', { leadId, err }));
  }
  return result;
}

/** A touch of any kind: the recency clock restarts, the score follows. */
export async function touchLead(leadId: string, at = new Date()): Promise<void> {
  await repository.update(leadId, { lastTouchedAt: at });
  await recomputeLead(leadId, at).catch((err) => logger.warn('Lead score not recomputed after a touch', { leadId, err }));
}

/** The nightly walk over every open lead, a page of ids at a time. */
export async function recomputeAll(now = new Date()): Promise<{ scored: number; moved: number }> {
  const policy = await scoringPolicy();
  let cursor: string | null = null;
  let scored = 0;
  let moved = 0;
  for (;;) {
    const ids: string[] = await repository.openLeadIdsAfter(cursor, 200);
    if (ids.length === 0) break;
    for (const id of ids) {
      const before = await repository.findForScoring(id, now);
      const result = await recomputeLead(id, now, policy);
      if (result) scored += 1;
      if (result && before?.temperature && before.temperature !== result.temperature) moved += 1;
    }
    cursor = ids[ids.length - 1]!;
  }
  return { scored, moved };
}

/** Each source's quality from its own 90-day conversion rate (D10's learned signal). */
export async function learnSourceQuality(now = new Date()): Promise<{ sources: number; changed: number }> {
  const policy = await scoringPolicy();
  const stats = await repository.sourceStats(new Date(now.getTime() - INTENT_WINDOW_DAYS * DAY_MS));
  const sources = await repository.listSources();
  let changed = 0;
  for (const source of sources) {
    const stat = stats.find((row) => row.sourceId === source.id);
    if (!stat) continue;
    const current = Number(source.quality);
    const next = learnedQuality(stat.created, stat.converted, current, policy.weights.sourceMax);
    if (next !== current) {
      await repository.updateSource(source.id, { quality: next });
      changed += 1;
    }
  }
  return { sources: sources.length, changed };
}

/** The reasons as the API prints them. */
export function reasonsOf(value: unknown): ScoreReason[] {
  return Array.isArray(value) ? (value as ScoreReason[]) : [];
}
