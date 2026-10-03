import type { Request } from 'express';
import { z } from 'zod';
import { AiUnavailableError, complete } from '../../shared/ai';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { hammingDistance, isModelReadableImage, readImageForModel } from '../uploads';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import type { CreativeAnalysisRow, CreativeReviewRow } from './campaigns.repository';

/**
 * VA-1 (23 Sep 2026): the vision pass over an advertiser's artwork.
 *
 * The owner: "analyse creatives submitted by advertisers in order to
 * determine if the creatives are appropriate, relevant, unique, legal and if
 * they're PG rated or regular." Five questions. Four go to the vision model
 * with the artwork and what the platform knows about the campaign; the
 * fifth — unique — is arithmetic, because "have we seen this picture before"
 * is a hash comparison and a model would only guess at it.
 *
 * What this is and is not. It is what the reviewer reads first: the
 * verdicts, the reasons, the flags from a fixed vocabulary, one paragraph.
 * It is **not a decision** — the desk's checklist stays the desk's, the
 * approve and reject buttons stay a person's, and the analysis is a row
 * beside the creative that says what a model thought and when. A re-upload
 * gets its own row, so the desk can see the verdict move.
 *
 * Cost: on demand from the desk, never on every upload. The picture is
 * downsized to a thousand pixels before it goes, and the model is asked for
 * a short JSON answer at low temperature.
 */

export const ANALYSIS_VERDICTS = ['PASS', 'FAIL', 'UNSURE'] as const;
export type AnalysisVerdict = (typeof ANALYSIS_VERDICTS)[number];

/** PG is fit for a family audience on a street; REGULAR for a general adult one; ADULT should not be on a hoarding at all. */
export const ANALYSIS_RATINGS = ['PG', 'REGULAR', 'ADULT'] as const;
export type AnalysisRating = (typeof ANALYSIS_RATINGS)[number];

/** A fixed vocabulary, so the desk can filter on a flag and a reviewer knows the words. */
export const ANALYSIS_FLAGS = [
  'TOBACCO',
  'ALCOHOL',
  'GAMBLING',
  'ADULT_CONTENT',
  'VIOLENCE',
  'HATE_OR_DISCRIMINATION',
  'POLITICAL',
  'RELIGIOUS_SENSITIVITY',
  'MISLEADING_CLAIM',
  'HEALTH_CLAIM',
  'PRICE_CLAIM',
  'MISSING_DISCLAIMER',
  'COMPETITOR_MARK',
  'CELEBRITY_LIKENESS',
  'CHILDREN_TARGETED',
  'LOW_LEGIBILITY',
  'OFF_BRIEF',
  'OTHER',
] as const;
export type AnalysisFlag = (typeof ANALYSIS_FLAGS)[number];

/** How many of the 64 hash bits may differ before two creatives count as different pictures. */
export const UNIQUE_DISTANCE = 10;

const verdict = z.object({
  verdict: z.enum(ANALYSIS_VERDICTS),
  reason: z.string().trim().max(400).default(''),
});

/** The shape the model is asked for, and held to. */
export const analysisAnswerSchema = z.object({
  appropriate: verdict,
  relevant: verdict,
  legal: verdict,
  rating: z.enum(ANALYSIS_RATINGS),
  ratingReason: z.string().trim().max(400).default(''),
  flags: z.array(z.string()).max(12).default([]),
  summary: z.string().trim().min(1).max(800),
  confidence: z.number().min(0).max(1),
});
export type AnalysisAnswer = z.infer<typeof analysisAnswerSchema>;

/**
 * The model's text, as the answer. Models wrap JSON in prose and fences
 * whatever they are told, so the first `{` to the last `}` is what is
 * parsed; a flag outside the vocabulary becomes OTHER rather than failing
 * the whole answer, because the summary beside it is still worth reading.
 */
export function parseAnalysisAnswer(text: string): AnalysisAnswer {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the answer');
  const parsed = analysisAnswerSchema.parse(JSON.parse(text.slice(start, end + 1)));
  const known = new Set<string>(ANALYSIS_FLAGS);
  const flags = [...new Set(parsed.flags.map((flag) => (known.has(flag) ? flag : 'OTHER')))];
  return { ...parsed, flags };
}

export const CREATIVE_REVIEW_SYSTEM = [
  'You review advertising artwork before it is printed on hoardings, walls, vehicles and screens across India,',
  'for a marketplace that must keep to the ASCI code, Indian advertising law and the norms of a street audience',
  'that includes children. You answer with one JSON object and nothing else, in this exact shape:',
  '{"appropriate":{"verdict":"PASS|FAIL|UNSURE","reason":"..."},',
  ' "relevant":{"verdict":"PASS|FAIL|UNSURE","reason":"..."},',
  ' "legal":{"verdict":"PASS|FAIL|UNSURE","reason":"..."},',
  ' "rating":"PG|REGULAR|ADULT","ratingReason":"...",',
  ` "flags":[${ANALYSIS_FLAGS.map((flag) => `"${flag}"`).join('|')}],`,
  ' "summary":"one short paragraph for the reviewer","confidence":0.0}',
  'appropriate = fit to be shown in public to anyone passing. relevant = the artwork advertises what the campaign says',
  'it advertises, for the advertiser named. legal = no claim, product or depiction that Indian law or the ASCI code',
  'forbids or requires a disclaimer for (tobacco, alcohol, gambling, health and price claims, misleading comparisons).',
  'rating: PG is fit for a family audience, REGULAR for a general adult one, ADULT should not be on a hoarding.',
  'Use UNSURE when the picture does not settle it. Flags only from the list. Never invent text you cannot read in the picture.',
].join(' ');

/** What the model is told about the campaign, beside the picture. */
export function creativePrompt(creative: CreativeReviewRow): string {
  const lines = [
    `Advertiser: ${creative.campaign.advertiser.companyName ?? creative.campaign.advertiser.name}`,
    creative.campaign.industry ? `Advertiser's industry: ${creative.campaign.industry}` : null,
    `Campaign: ${creative.campaign.name}`,
    creative.spot ? `Placement: ${creative.spot.listing.title}${creative.spot.listing.city ? `, ${creative.spot.listing.city}` : ''}` : 'Placement: every spot in the campaign',
    creative.spot?.listing.widthFt && creative.spot.listing.heightFt ? `Spot size: ${String(creative.spot.listing.widthFt)} × ${String(creative.spot.listing.heightFt)} ft` : null,
    creative.widthPx && creative.heightPx ? `Artwork: ${creative.widthPx} × ${creative.heightPx} px` : null,
    'Judge the artwork in the picture against the five questions and answer with the JSON object only.',
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

export type CreativeAnalysisView = {
  id: string;
  creativeId: string;
  provider: string;
  model: string;
  appropriate: { verdict: AnalysisVerdict; reason: string | null };
  relevant: { verdict: AnalysisVerdict; reason: string | null };
  legal: { verdict: AnalysisVerdict; reason: string | null };
  rating: AnalysisRating;
  ratingReason: string | null;
  flags: string[];
  summary: string;
  confidence: number;
  unique: boolean | null;
  nearest: { creativeId: string; distance: number } | null;
  createdAt: string;
};

export function toAnalysisView(row: CreativeAnalysisRow): CreativeAnalysisView {
  return {
    id: row.id,
    creativeId: row.creativeId,
    provider: row.provider,
    model: row.model,
    appropriate: { verdict: row.appropriate as AnalysisVerdict, reason: row.appropriateReason },
    relevant: { verdict: row.relevant as AnalysisVerdict, reason: row.relevantReason },
    legal: { verdict: row.legal as AnalysisVerdict, reason: row.legalReason },
    rating: row.rating as AnalysisRating,
    ratingReason: row.ratingReason,
    flags: row.flags,
    summary: row.summary,
    confidence: row.confidence,
    unique: row.unique,
    nearest: row.nearestCreativeId && row.nearestDistance !== null ? { creativeId: row.nearestCreativeId, distance: row.nearestDistance } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The latest run, for the desk's read of a creative. Null when nobody has asked. */
export async function latestCreativeAnalysis(creativeId: string): Promise<CreativeAnalysisView | null> {
  const row = await repository.latestCreativeAnalysis(creativeId);
  return row ? toAnalysisView(row) : null;
}

/**
 * The uniqueness check, by hash: the closest other creative on the
 * platform, and whether it is close enough to be the same picture. Pure
 * over the rows it is given, so the threshold is one number in one place.
 */
export function nearestByHash(hash: string, others: { id: string; perceptualHash: string | null }[]): { creativeId: string; distance: number } | null {
  let best: { creativeId: string; distance: number } | null = null;
  for (const other of others) {
    if (!other.perceptualHash) continue;
    const distance = hammingDistance(hash, other.perceptualHash);
    if (!best || distance < best.distance) best = { creativeId: other.id, distance };
  }
  return best;
}

export async function analyseCreative(creativeId: string, actor: { userId: string; req?: Request }): Promise<CreativeAnalysisView> {
  const creative = await repository.findCreative(creativeId);
  if (!creative) throw new ApiError(404, 'NOT_FOUND', 'Creative not found');
  if (!creative.fileUrl) throw new ApiError(409, 'NO_FILE', 'Nothing has been uploaded for this creative yet');
  if (!isModelReadableImage(creative.mimeType)) {
    throw new ApiError(409, 'ANALYSIS_UNSUPPORTED', 'Only a still image can be analysed. A video or motion creative is reviewed by eye.');
  }

  const image = await readImageForModel(creative.fileUrl);

  // Unique, by arithmetic: every other current creative's hash, this one's kept for the next.
  const others = await repository.listCreativeHashes(creativeId);
  const nearest = nearestByHash(image.perceptualHash, others);
  const unique = nearest ? nearest.distance > UNIQUE_DISTANCE : true;
  await repository.updateCreative(creativeId, { perceptualHash: image.perceptualHash });

  let text: string;
  let provider: string;
  let model: string;
  try {
    const result = await complete({
      system: CREATIVE_REVIEW_SYSTEM,
      prompt: creativePrompt(creative),
      maxTokens: 700,
      temperature: 0.1,
      images: [{ mimeType: image.mimeType, base64: image.base64 }],
    });
    text = result.text;
    provider = result.provider;
    model = result.model;
  } catch (cause) {
    if (cause instanceof AiUnavailableError) throw new ApiError(503, 'AI_UNAVAILABLE', cause.message);
    throw new ApiError(502, 'AI_FAILED', (cause as Error).message);
  }

  let answer: AnalysisAnswer;
  try {
    answer = parseAnalysisAnswer(text);
  } catch (cause) {
    throw new ApiError(502, 'AI_FAILED', `The model did not answer in the shape asked: ${(cause as Error).message}`);
  }

  const row = await repository.createCreativeAnalysis({
    creativeId,
    provider,
    model,
    appropriate: answer.appropriate.verdict,
    appropriateReason: answer.appropriate.reason || null,
    relevant: answer.relevant.verdict,
    relevantReason: answer.relevant.reason || null,
    legal: answer.legal.verdict,
    legalReason: answer.legal.reason || null,
    rating: answer.rating,
    ratingReason: answer.ratingReason || null,
    flags: answer.flags,
    summary: answer.summary,
    confidence: answer.confidence,
    unique,
    nearestCreativeId: nearest?.creativeId ?? null,
    nearestDistance: nearest?.distance ?? null,
    raw: { text, image: { width: image.width, height: image.height } },
    requestedByUserId: actor.userId,
  });

  await logActivity(actor.userId, 'CREATIVE_ANALYSED', {
    req: actor.req,
    targetType: 'CampaignCreative',
    targetId: creativeId,
    module: 'campaigns',
    metadata: { provider, model, appropriate: answer.appropriate.verdict, relevant: answer.relevant.verdict, legal: answer.legal.verdict, rating: answer.rating, flags: answer.flags, unique, nearest },
  });

  return toAnalysisView(row);
}

/* ------------------------------------------------------------------ */
/* VA-4: the queue's batch                                             */
/* ------------------------------------------------------------------ */

export type AnalyseBatchResult = {
  analysed: string[];
  skipped: { creativeId: string; reason: string }[];
  failed: { creativeId: string; reason: string }[];
};

/** A morning's queue; the vendor is rate-limited and a reviewer reads them one at a time anyway. */
export const ANALYSE_BATCH_LIMIT = 50;

const SKIPPED_CODES = new Set(['NO_FILE', 'ANALYSIS_UNSUPPORTED', 'NOT_FOUND']);

/**
 * The batch: the named artworks, or — with none named — everything awaiting
 * review that is a still image with no reading yet, oldest submission
 * first, up to the limit. One at a time, each the same on-demand run as a
 * single click: the readings are independent and nothing is decided. An
 * artwork the model cannot be given (a video, nothing uploaded) is skipped
 * rather than failing the run; a vendor that falls over on one is recorded
 * against that one and the run goes on; "switched off" (503) stops the run
 * at once, because every remaining one would end the same way.
 */
export async function analyseCreatives(actor: { userId: string; req?: Request }, creativeIds?: string[]): Promise<AnalyseBatchResult> {
  const ids = creativeIds?.length
    ? creativeIds.slice(0, ANALYSE_BATCH_LIMIT)
    : (await repository.listCreativesAwaitingAnalysis(ANALYSE_BATCH_LIMIT)).map((row) => row.id);
  const result: AnalyseBatchResult = { analysed: [], skipped: [], failed: [] };
  for (const creativeId of ids) {
    try {
      await analyseCreative(creativeId, actor);
      result.analysed.push(creativeId);
    } catch (cause) {
      if (cause instanceof ApiError && cause.statusCode === 503) throw cause;
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof ApiError && SKIPPED_CODES.has(cause.code)) result.skipped.push({ creativeId, reason });
      else result.failed.push({ creativeId, reason });
    }
  }
  return result;
}
