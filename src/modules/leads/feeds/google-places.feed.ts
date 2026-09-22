import { ApiError } from '../../../shared/errors';
import { getEffectiveMapsConfig } from '../../../shared/integrations';
import { logger } from '../../../shared/logging';
import { bboxOf, pointInRing, type FeedCandidate, type FeedSearch, type LeadFeed } from './feed.port';

/**
 * LH3: Google Places (New) Text Search — the first directory feed (D4:
 * "Google Places first"). Rides the maps seam's server key (`maps.
 * googleServerKey`, the same key geocoding spends), so a platform that
 * geocodes through Google already has this feed. Each call is billed by
 * Google per request and per field mask, which is why the mask below is
 * the small one and the cap is the run's own `limit`.
 */

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.primaryType,places.addressComponents';
const PAGE = 20;

type GooglePlace = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  primaryType?: string;
  addressComponents?: { longText?: string; types?: string[] }[];
};

async function serverKey(): Promise<string | null> {
  const { googleServerKey } = await getEffectiveMapsConfig();
  return googleServerKey?.trim() || null;
}

function component(place: GooglePlace, type: string): string | null {
  return place.addressComponents?.find((part) => part.types?.includes(type))?.longText ?? null;
}

/** Google's place as the importer's row. */
export function candidateOf(place: GooglePlace, category: string): FeedCandidate {
  return {
    externalKey: `google-places:${place.id}`,
    businessName: place.displayName?.text ?? place.id,
    category,
    phone: place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null,
    address: place.formattedAddress ?? place.shortFormattedAddress ?? null,
    locality: component(place, 'sublocality_level_1') ?? component(place, 'sublocality') ?? component(place, 'neighborhood') ?? null,
    city: component(place, 'locality') ?? component(place, 'administrative_area_level_2') ?? null,
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
    extra: { website: place.websiteUri ?? null, primaryType: place.primaryType ?? null },
  };
}

export const googlePlacesFeed: LeadFeed = {
  key: 'google-places',
  label: 'Google Places',
  needs: 'The Google Maps server key under Settings › Integrations › Maps (Places API (New) enabled on it).',
  async configured() {
    return (await serverKey()) ? { ok: true } : { ok: false, reason: 'Google Maps is not configured: no server key is set.' };
  },
  async search(input: FeedSearch): Promise<FeedCandidate[]> {
    const key = await serverKey();
    if (!key) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Google Places is not configured: no Google Maps server key is set.');
    const box = input.polygon ? bboxOf(input.polygon) : null;
    const textQuery = box ? input.category : `${input.category} in ${input.city ?? 'India'}`;
    const out: FeedCandidate[] = [];
    let pageToken: string | undefined;
    while (out.length < input.limit) {
      const body: Record<string, unknown> = {
        textQuery,
        pageSize: Math.min(PAGE, input.limit - out.length),
        regionCode: 'IN',
        languageCode: 'en',
        ...(box ? { locationRestriction: { rectangle: { low: { latitude: box.south, longitude: box.west }, high: { latitude: box.north, longitude: box.east } } } } : {}),
        ...(pageToken ? { pageToken } : {}),
      };
      let response: Response;
      try {
        response = await fetch(SEARCH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': `${FIELD_MASK},nextPageToken` },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        logger.error('Google Places unreachable', { err: cause });
        throw new ApiError(502, 'INTERNAL_ERROR', 'Google Places could not be reached.');
      }
      if (response.status === 429) throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Google Places quota exhausted for now.');
      if (response.status === 403 || response.status === 401) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Google refused the Maps server key for Places (enable Places API (New) on it).');
      if (response.status === 400) throw new ApiError(400, 'VALIDATION_ERROR', 'Google Places refused the search as malformed.');
      if (!response.ok) throw new ApiError(502, 'INTERNAL_ERROR', `Google Places answered HTTP ${response.status}.`);
      const payload = (await response.json()) as { places?: GooglePlace[]; nextPageToken?: string };
      for (const place of payload.places ?? []) {
        const candidate = candidateOf(place, input.category);
        // A drawn polygon is honoured exactly; the rectangle Google took was only the coarse cut.
        if (input.polygon && candidate.latitude !== null && candidate.latitude !== undefined && candidate.longitude !== null && candidate.longitude !== undefined && !pointInRing({ latitude: candidate.latitude, longitude: candidate.longitude }, input.polygon)) continue;
        out.push(candidate);
        if (out.length >= input.limit) break;
      }
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  },
};
