import { createHash } from 'node:crypto';
import { ApiError } from '../../shared/errors';
import { complete, AiUnavailableError } from '../../shared/ai';
import { getEffectiveAiConfig } from '../../shared/integrations';
import { prismaAiRepository as repository } from './prisma-ai.repository';

/**
 * Drafting a listing description, and translating the marketplace.
 *
 * Two jobs, one model, because they are the same capability pointed at
 * different text. Both go through `shared/ai`, so neither knows which vendor is
 * configured.
 */

/* ------------------------------------------------------------------ */
/* Description drafting                                                */
/* ------------------------------------------------------------------ */

/**
 * What the model is told about the spot.
 *
 * Every field is optional because a publisher can ask for a draft at step 5
 * with only the earlier steps answered, and a half-filled form should still
 * produce something rather than an error.
 */
export type DescriptionContext = {
  title?: string;
  venueType?: string;
  mediaType?: string;
  placement?: string;
  city?: string;
  address?: string;
  widthFt?: string;
  heightFt?: string;
  material?: string;
  targetAudience?: string;
  footfallNote?: string;
  uniqueSellingPoint?: string;
};

export type GenerateRequest = {
  userId: string;
  /** The listing being edited, when there is one. */
  listingId?: string;
  /** The wizard's own key for a listing that does not exist yet. */
  draftKey?: string;
  /** What is in the field right now. The rule below turns on this. */
  current: string;
  context: DescriptionContext;
};

export type GenerateResult = {
  text: string;
  /** Drafts already taken against this description, including this one. */
  used: number;
  /** What this publisher is allowed for one description. */
  quota: number;
};

const SYSTEM = [
  'You write short factual descriptions of out-of-home advertising spaces in India',
  'for a marketplace where advertisers browse and book them.',
  'Four or five lines. Plain English, no marketing superlatives, no invented numbers.',
  'Describe only what the details given actually say — never claim footfall, visibility',
  'or audience figures that were not provided. Write prose, not a bulleted list,',
  'and do not repeat the address back verbatim.',
].join(' ');

function promptFrom(context: DescriptionContext): string {
  const lines = Object.entries({
    Title: context.title,
    Venue: context.venueType,
    Format: context.mediaType,
    Placement: context.placement,
    City: context.city,
    Address: context.address,
    Size: context.widthFt && context.heightFt ? `${context.widthFt} x ${context.heightFt} ft` : undefined,
    Material: context.material,
    'Audience the publisher describes': context.targetAudience,
    'Footfall note': context.footfallNote,
    'What makes it unusual': context.uniqueSellingPoint,
  })
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([label, value]) => `${label}: ${String(value).trim()}`);

  return `Write the description for this advertising space.\n\n${lines.join('\n')}`;
}

/**
 * The quota bucket.
 *
 * A description is regenerated while it is being written, which is before there
 * is a listing to point at, so the wizard supplies its own key until there is
 * one. The publisher id is always part of it: a draft key comes from the client
 * and is not a secret, and without the owner in the key one publisher could
 * spend another's allowance by guessing.
 */
function subjectKeyFor(publisherId: string, listingId?: string, draftKey?: string): string {
  if (listingId) return `listing:${listingId}`;
  return `draft:${publisherId}:${draftKey}`;
}

export async function generateDescription(request: GenerateRequest): Promise<GenerateResult> {
  const publisherId = await repository.findPublisherIdByUserId(request.userId);
  if (!publisherId) {
    throw new ApiError(403, 'FORBIDDEN', 'Only a publisher can draft a listing description.');
  }

  if (!request.listingId && !request.draftKey) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A listing id or a draft key is required.');
  }
  if (request.listingId && !(await repository.listingBelongsTo(request.listingId, publisherId))) {
    // Reported as not-found rather than forbidden: whether a listing exists is
    // not something a stranger gets to learn by asking.
    throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  }

  /*
   * The blank-field rule.
   *
   * Generating over text a publisher has already written is the one way this
   * feature can destroy work, and an undo in the client is not a defence — the
   * request has already been paid for and the words are already gone. So the
   * server refuses, and clearing the field is the deliberate act that says the
   * old wording is finished with.
   */
  if (request.current.trim() !== '') {
    throw new ApiError(
      409,
      'FIELD_NOT_EMPTY',
      'Clear the description before generating a new one — this will not write over what you have already written.'
    );
  }

  const config = await getEffectiveAiConfig();
  const paid = await repository.hasActiveSubscription(publisherId);
  const quota = paid ? config.paidQuota : config.freeQuota;

  const subjectKey = subjectKeyFor(publisherId, request.listingId, request.draftKey);
  const used = await repository.countGenerations(publisherId, subjectKey);

  if (used >= quota) {
    throw new ApiError(
      429,
      'QUOTA_EXHAUSTED',
      paid
        ? `You have used all ${quota} drafts for this description. Edit the one you have, or write your own.`
        : `You have used all ${quota} free drafts for this description. A subscription raises this to ${config.paidQuota}.`
    );
  }

  let result;
  try {
    result = await complete({
      system: SYSTEM,
      prompt: promptFrom(request.context),
      maxTokens: 400,
      temperature: 0.7,
    });
  } catch (cause) {
    // "Switched off" is an operator's problem and "unreachable" is a vendor's;
    // reporting both as a failed generation makes the first look like a bug.
    if (cause instanceof AiUnavailableError) {
      throw new ApiError(503, 'AI_UNAVAILABLE', cause.message);
    }
    throw new ApiError(502, 'AI_FAILED', (cause as Error).message);
  }

  // Recorded after the model answers, so a vendor outage does not spend a draft.
  await repository.recordGeneration({
    publisherId,
    subjectKey,
    kind: 'LISTING_DESCRIPTION',
    provider: result.provider,
    model: result.model,
    output: result.text,
  });

  return { text: result.text, used: used + 1, quota };
}

/** What is left, for a button that should say so before it is pressed. */
export async function descriptionQuota(
  userId: string,
  listingId?: string,
  draftKey?: string
): Promise<{ used: number; quota: number; paid: boolean }> {
  const publisherId = await repository.findPublisherIdByUserId(userId);
  if (!publisherId) {
    throw new ApiError(403, 'FORBIDDEN', 'Only a publisher can draft a listing description.');
  }

  const config = await getEffectiveAiConfig();
  const paid = await repository.hasActiveSubscription(publisherId);
  const subjectKey = subjectKeyFor(publisherId, listingId, draftKey);
  const used = await repository.countGenerations(publisherId, subjectKey);

  return { used, quota: paid ? config.paidQuota : config.freeQuota, paid };
}

/* ------------------------------------------------------------------ */
/* The advertiser's landing page — E7-2                                */
/* ------------------------------------------------------------------ */

/**
 * The same quota, on the advertiser's side. A campaign's landing page is
 * redrafted from the brief the way a listing description is, and the same
 * two numbers cap it — three free, ten with a plan ACTIVE. The bucket is
 * the campaign: `subjectKey` is its id, so the count is per page, not per
 * advertiser. `campaigns` asks before it calls the model and records after
 * the model answers, so a vendor outage spends nothing — the rule the
 * listing draft keeps.
 */
export type LandingPageQuota = { used: number; quota: number; paid: boolean };

export async function landingPageQuota(advertiserId: string, campaignId: string): Promise<LandingPageQuota> {
  const [config, paid, used] = await Promise.all([
    getEffectiveAiConfig(),
    repository.hasActivePlan(advertiserId),
    repository.countAdvertiserGenerations(advertiserId, campaignId),
  ]);
  return { used, quota: paid ? config.paidQuota : config.freeQuota, paid };
}

/** 429 QUOTA_EXHAUSTED when the page has had its drafts; the quota otherwise. */
export async function assertLandingPageQuota(advertiserId: string, campaignId: string): Promise<LandingPageQuota> {
  const quota = await landingPageQuota(advertiserId, campaignId);
  if (quota.used >= quota.quota) {
    throw new ApiError(
      429,
      'QUOTA_EXHAUSTED',
      quota.paid
        ? `You have used all ${quota.quota} drafts for this page. Edit the one you have.`
        : `You have used all ${quota.quota} free drafts for this page. An active plan raises this to ${(await getEffectiveAiConfig()).paidQuota}.`
    );
  }
  return quota;
}

export async function recordLandingPageGeneration(input: {
  advertiserId: string;
  campaignId: string;
  provider: string;
  model: string;
  output: string;
}): Promise<void> {
  await repository.recordGeneration({
    publisherId: null,
    advertiserId: input.advertiserId,
    subjectKey: input.campaignId,
    kind: 'LANDING_PAGE',
    provider: input.provider,
    model: input.model,
    output: input.output,
  });
}

/* ------------------------------------------------------------------ */
/* Read-path translation                                               */
/* ------------------------------------------------------------------ */

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A field that was translated, and what it said before. */
export type TranslatedField = {
  text: string;
  original: string;
  /** The language the reader asked for. */
  language: string;
};

const TRANSLATE_SYSTEM = [
  'You translate listing text for an Indian out-of-home advertising marketplace.',
  'Return only the translation, with no preamble, quotes or explanation.',
  'Keep place names, brand names, measurements and currency amounts exactly as written.',
  'If the text is already in the target language, return it unchanged.',
].join(' ');

/**
 * Translates a batch of strings into one language, cache first.
 *
 * Batched because a marketplace page is thirty listings and thirty round trips
 * to a model is a page that never loads. The cache is keyed by the hash of the
 * text, so the same sentence across forty listings is paid for once and an
 * edit reverted costs nothing.
 *
 * A failure here is not an error. The marketplace has to render, so anything
 * that could not be translated comes back as it was written — a description in
 * the wrong language is worse than one in the right language and much better
 * than a page that will not load.
 */
export async function translateBatch(
  texts: string[],
  targetLang: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  const config = await getEffectiveAiConfig();
  if (!config.enabled || !config.translateOnRead) return out;

  const distinct = [...new Set(texts.map((text) => text.trim()).filter((text) => text !== ''))];
  if (distinct.length === 0) return out;

  const hashes = distinct.map(hash);
  const cached = await repository.findTranslations(hashes, targetLang);

  const missing: string[] = [];
  for (const text of distinct) {
    const hit = cached.get(hash(text));
    if (hit) out.set(text, hit.text);
    else missing.push(text);
  }

  for (const text of missing) {
    try {
      const result = await complete({
        system: TRANSLATE_SYSTEM,
        prompt: `Translate into ${targetLang}:\n\n${text}`,
        maxTokens: 600,
        // Translation is not a place for invention.
        temperature: 0,
      });
      out.set(text, result.text);
      await repository.saveTranslation({
        sourceHash: hash(text),
        targetLang,
        sourceLang: null,
        text: result.text,
        provider: result.provider,
      });
    } catch {
      // Left out of the map on purpose: the caller falls back to the original.
      continue;
    }
  }

  return out;
}

/** The language a reader should be served, from their profile. */
export async function readerLanguage(userId: string): Promise<string> {
  return (await repository.findUserLanguage(userId)) ?? 'en';
}
