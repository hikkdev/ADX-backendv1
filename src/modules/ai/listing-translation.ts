import { getEffectiveAiConfig } from '../../shared/integrations';
import { readerLanguage, translateBatch } from './ai.service';

/**
 * Translating listings on the way out.
 *
 * The decision was that translation belongs to the read path for the whole
 * marketplace rather than to one field: a publisher in Kochi writes their spot
 * up in Malayalam, and an advertiser in Delhi should be reading it in whatever
 * language their phone is set to, without either of them doing anything.
 *
 * Six fields, and they are the six a publisher writes in their own words. Not
 * the address — a courier and a hoarding installer both need it as written —
 * and not the city, which is a name that becomes harder to match against a map
 * once it is translated.
 *
 * Every translated field keeps its original beside it, because the answer to
 * "what did they actually write" has to survive the convenience. That is what
 * the revert control in the apps reads.
 */

const FIELDS = [
  'title',
  'description',
  'targetAudience',
  'uniqueSellingPoint',
  'footfallNote',
  'peakPeriodNote',
] as const;

type Field = (typeof FIELDS)[number];

/** What a listing looks like once it has been through here. */
export type Translated<T> = T & {
  /** Absent when nothing was translated. */
  originals?: Partial<Record<Field, string>>;
  /** The language the text is now in, when it was changed. */
  translatedTo?: string;
};

/**
 * Translates a page of listings into the reader's language.
 *
 * Returns the rows untouched whenever there is nothing to do — the feature is
 * off, the reader already speaks the language the text is in, or the provider
 * could not be reached. A marketplace that will not render because a
 * translation failed is a worse product than one showing the original words.
 */
export async function translateListings<T extends Record<string, unknown>>(
  rows: T[],
  userId: string
): Promise<Translated<T>[]> {
  const config = await getEffectiveAiConfig();
  if (!config.enabled || !config.translateOnRead || rows.length === 0) return rows;

  const target = await readerLanguage(userId);

  // Every distinct string on the page, translated in one pass. Thirty listings
  // with six fields each is a hundred and eighty strings and a great many
  // repeats — "Shopping mall atrium" is not translated forty times.
  const source: string[] = [];
  for (const row of rows) {
    for (const field of FIELDS) {
      const value = row[field];
      if (typeof value === 'string' && value.trim() !== '') source.push(value.trim());
    }
  }

  const translations = await translateBatch(source, target);
  if (translations.size === 0) return rows;

  return rows.map((row) => {
    const originals: Partial<Record<Field, string>> = {};
    const patched: Record<string, unknown> = { ...row };

    for (const field of FIELDS) {
      const value = row[field];
      if (typeof value !== 'string' || value.trim() === '') continue;
      const translated = translations.get(value.trim());
      // Unchanged text means the model judged it already in the target
      // language; recording that as a translation would offer a revert control
      // that reverts to the same words.
      if (!translated || translated === value) continue;
      originals[field] = value;
      patched[field] = translated;
    }

    if (Object.keys(originals).length === 0) return row as Translated<T>;
    return { ...(patched as T), originals, translatedTo: target };
  });
}
