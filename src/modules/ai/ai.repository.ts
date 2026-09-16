import type { AiGenerationKind } from '../../shared/database';

/**
 * What the AI module needs from storage, and nothing else.
 */

/**
 * One of the two owners is set: the publisher whose listing description this
 * is, or (E7-2, Lot E addendum 2) the advertiser whose landing page it is.
 */
export type NewGeneration = {
  publisherId: string | null;
  advertiserId?: string | null;
  subjectKey: string;
  kind: AiGenerationKind;
  provider: string;
  model: string;
  output: string;
};

export type CachedTranslation = {
  text: string;
  sourceLang: string | null;
};

export type NewTranslation = {
  sourceHash: string;
  targetLang: string;
  sourceLang: string | null;
  text: string;
  provider: string;
};

export interface AiRepository {
  /** How many drafts this publisher has already had for this description. */
  countGenerations(publisherId: string, subjectKey: string): Promise<number>;
  /** E7-2: how many drafts this advertiser has already had for this page. */
  countAdvertiserGenerations(advertiserId: string, subjectKey: string): Promise<number>;
  recordGeneration(data: NewGeneration): Promise<void>;

  /** Whether the publisher has a subscription running right now. */
  hasActiveSubscription(publisherId: string): Promise<boolean>;
  /** E7-2: whether the advertiser has a plan ACTIVE right now — the paid quota on their side. */
  hasActivePlan(advertiserId: string): Promise<boolean>;

  /** Resolves the caller's publisher, since the wire never carries one. */
  findPublisherIdByUserId(userId: string): Promise<string | null>;

  /** Confirms a listing belongs to the publisher before it names a quota bucket. */
  listingBelongsTo(listingId: string, publisherId: string): Promise<boolean>;

  findTranslations(
    sourceHashes: string[],
    targetLang: string
  ): Promise<Map<string, CachedTranslation>>;
  saveTranslation(data: NewTranslation): Promise<void>;

  /** The reader's language, as their profile records it. */
  findUserLanguage(userId: string): Promise<string | null>;
}
