import { ApiError } from '../errors';
import { getEffectiveMapsConfig } from '../integrations';
import { logger } from '../logging';
import type {
  AutocompleteOptions,
  Directions,
  DirectionsMode,
  GeoPoint,
  GeocodedPlace,
  MapsProvider,
  PlacePrediction,
} from './types';

/**
 * Google Maps Platform, behind the maps seam (G7 — moved here from
 * `modules/geo/google.client.ts`, the lookups unchanged).
 *
 * Four services, one key: Geocoding (address ↔ coordinates), Places
 * Autocomplete (a typed fragment → candidate places), Place Details (a
 * candidate → its coordinates) and — Q137 — the Routes API for directions,
 * which is the one Google surface that knows `TWO_WHEELER` in India. The key
 * comes from `getEffectiveMapsConfig().googleServerKey` — the integrations
 * row first, then the pre-G7 row, then the environment — so ops can rotate it
 * from a screen without a deploy.
 *
 * This is the SERVER key, restricted by IP on Google's side. The apps carry
 * the browser key (`GET /app/maps`), restricted by package and bundle id, and
 * never call these endpoints for tiles — only for the lookups a phone should
 * not spend its own quota on.
 *
 * Every answer is normalised here so nothing above this file knows Google's
 * shapes: `address_components` becomes city / state / postal code, and the
 * status vocabulary becomes ApiErrors a client can act on. No key is a 503 a
 * screen can explain, not a crash.
 */

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const AUTOCOMPLETE_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/** Results are biased to India; the platform sells nowhere else yet. */
const REGION = 'in';

/* ------------------------------------------------------------------ */
/* Google's shapes — confined to this file                             */
/* ------------------------------------------------------------------ */

type GoogleStatus =
  | 'OK'
  | 'ZERO_RESULTS'
  | 'OVER_QUERY_LIMIT'
  | 'REQUEST_DENIED'
  | 'INVALID_REQUEST'
  | 'UNKNOWN_ERROR'
  | 'NOT_FOUND';

type GoogleEnvelope = { status: GoogleStatus; error_message?: string };

type AddressComponent = { long_name: string; short_name: string; types: string[] };

type GeocodeResult = {
  formatted_address: string;
  place_id?: string;
  geometry: { location: { lat: number; lng: number } };
  address_components: AddressComponent[];
};

type GeocodeResponse = GoogleEnvelope & { results: GeocodeResult[] };

type AutocompleteResponse = GoogleEnvelope & {
  predictions: {
    place_id: string;
    description: string;
    structured_formatting?: { main_text: string; secondary_text?: string };
  }[];
};

type DetailsResponse = GoogleEnvelope & {
  result: {
    name?: string;
    formatted_address: string;
    place_id: string;
    geometry: { location: { lat: number; lng: number } };
    address_components?: AddressComponent[];
  };
};

/** Routes API v2 `computeRoutes`, trimmed to the field mask below. */
type RoutesResponse = {
  routes?: {
    distanceMeters?: number;
    /** "1234s" */
    duration?: string;
    polyline?: { encodedPolyline?: string };
    legs?: {
      steps?: {
        distanceMeters?: number;
        staticDuration?: string;
        navigationInstruction?: { maneuver?: string; instructions?: string };
        polyline?: { encodedPolyline?: string };
      }[];
    }[];
  }[];
  error?: { code?: number; message?: string; status?: string };
};

const ROUTES_FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.polyline.encodedPolyline',
].join(',');

/** Q137: Google's travel modes for the two the agent app offers. */
const TRAVEL_MODES: Record<DirectionsMode, 'DRIVE' | 'TWO_WHEELER'> = {
  driving: 'DRIVE',
  two_wheeler: 'TWO_WHEELER',
};

/* ------------------------------------------------------------------ */
/* The one call, and the one status table                             */
/* ------------------------------------------------------------------ */

async function requireKey(): Promise<string> {
  const { googleServerKey } = await getEffectiveMapsConfig();
  const key = googleServerKey?.trim();
  if (!key) {
    throw new ApiError(
      503,
      'INTEGRATION_NOT_CONFIGURED',
      'Google Maps is not configured: no API key is set.',
    );
  }
  return key;
}

/**
 * Calls Google and turns its status into an answer or an ApiError.
 *
 * Null means "asked correctly, nothing there" — ZERO_RESULTS for a lookup,
 * NOT_FOUND for a place id — and is the caller's to turn into a 404 or an
 * empty list. Everything else is a failure somebody can act on: quota (429),
 * a refused key (503, the same code as no key, because to a screen it is the
 * same problem), a malformed request (400), and Google being down (502).
 */
async function call<T extends GoogleEnvelope>(url: URL, what: string): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch (cause) {
    logger.error('Google Maps unreachable', { what, err: cause });
    throw new ApiError(502, 'INTERNAL_ERROR', 'Google Maps could not be reached.');
  }
  if (!response.ok) {
    throw new ApiError(502, 'INTERNAL_ERROR', `Google Maps answered HTTP ${response.status}.`);
  }
  const body = (await response.json()) as T;
  switch (body.status) {
    case 'OK':
      return body;
    case 'ZERO_RESULTS':
    case 'NOT_FOUND':
      return null;
    case 'OVER_QUERY_LIMIT':
      throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Google Maps quota is exhausted. Try again shortly.');
    case 'REQUEST_DENIED':
      logger.error('Google Maps refused the key', { what, message: body.error_message });
      throw new ApiError(
        503,
        'INTEGRATION_NOT_CONFIGURED',
        'Google Maps refused the request. Check the key and its API restrictions.',
      );
    case 'INVALID_REQUEST':
      throw new ApiError(400, 'BAD_REQUEST', body.error_message ?? 'Google Maps rejected the request.');
    default:
      logger.error('Google Maps unexpected status', { what, status: body.status, message: body.error_message });
      throw new ApiError(502, 'INTERNAL_ERROR', `Google Maps answered ${body.status}.`);
  }
}

function component(components: AddressComponent[] | undefined, type: string): string | null {
  return components?.find((c) => c.types.includes(type))?.long_name ?? null;
}

function toPlace(result: {
  formatted_address: string;
  place_id?: string;
  geometry: { location: { lat: number; lng: number } };
  address_components?: AddressComponent[];
}): GeocodedPlace {
  const components = result.address_components;
  return {
    formattedAddress: result.formatted_address,
    latitude: result.geometry.location.lat,
    longitude: result.geometry.location.lng,
    placeId: result.place_id ?? null,
    // Indian addresses put the city in `locality`; where Google files it under
    // the district instead, that is the next best thing to call a city.
    city: component(components, 'locality') ?? component(components, 'administrative_area_level_2'),
    state: component(components, 'administrative_area_level_1'),
    postalCode: component(components, 'postal_code'),
  };
}

/** "1234s" → 1234; anything else → 0. */
const seconds = (duration: string | undefined): number => {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration ?? '');
  return match ? Math.round(Number(match[1])) : 0;
};

/* ------------------------------------------------------------------ */
/* The four lookups                                                    */
/* ------------------------------------------------------------------ */

/** An address as typed → the best match, or null when nothing matches. */
export async function geocodeAddress(address: string): Promise<GeocodedPlace | null> {
  const key = await requireKey();
  const url = new URL(GEOCODE_URL);
  url.searchParams.set('address', address);
  url.searchParams.set('region', REGION);
  url.searchParams.set('key', key);
  const body = await call<GeocodeResponse>(url, 'geocode');
  const first = body?.results[0];
  return first ? toPlace(first) : null;
}

/** Coordinates → the most specific address Google has for them, or null. */
export async function reverseGeocode(point: GeoPoint): Promise<GeocodedPlace | null> {
  const key = await requireKey();
  const url = new URL(GEOCODE_URL);
  url.searchParams.set('latlng', `${point.latitude},${point.longitude}`);
  url.searchParams.set('key', key);
  const body = await call<GeocodeResponse>(url, 'reverse-geocode');
  const first = body?.results[0];
  return first ? toPlace(first) : null;
}

/**
 * A typed fragment → candidate places, India only.
 *
 * Predictions carry no coordinates by design (Google bills those separately);
 * a screen that needs the point calls `placeDetails` with the chosen id and
 * the same session token, so the whole search bills as one session.
 */
export async function autocompletePlaces(
  input: string,
  options: AutocompleteOptions = {},
): Promise<PlacePrediction[]> {
  const key = await requireKey();
  const url = new URL(AUTOCOMPLETE_URL);
  url.searchParams.set('input', input);
  url.searchParams.set('components', `country:${REGION}`);
  url.searchParams.set('key', key);
  if (options.sessionToken) url.searchParams.set('sessiontoken', options.sessionToken);
  if (options.near) {
    url.searchParams.set('location', `${options.near.latitude},${options.near.longitude}`);
    url.searchParams.set('radius', String(options.radiusM ?? 50_000));
  }
  const body = await call<AutocompleteResponse>(url, 'autocomplete');
  if (!body) return [];
  return body.predictions.map((p) => ({
    placeId: p.place_id,
    description: p.description,
    mainText: p.structured_formatting?.main_text ?? p.description,
    secondaryText: p.structured_formatting?.secondary_text ?? null,
  }));
}

/** A chosen prediction → its coordinates and address, or null for a dead id. */
export async function placeDetails(
  placeId: string,
  sessionToken?: string,
): Promise<(GeocodedPlace & { name: string | null }) | null> {
  const key = await requireKey();
  const url = new URL(DETAILS_URL);
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'name,formatted_address,place_id,geometry,address_components');
  url.searchParams.set('key', key);
  if (sessionToken) url.searchParams.set('sessiontoken', sessionToken);
  const body = await call<DetailsResponse>(url, 'place-details');
  if (!body) return null;
  return { ...toPlace(body.result), name: body.result.name ?? null };
}

/* ------------------------------------------------------------------ */
/* Q137: directions, through the Routes API                            */
/* ------------------------------------------------------------------ */

/**
 * A route from `from` to `to`, or null when Google finds none.
 *
 * The Routes API rather than the legacy Directions API because only it knows
 * `TWO_WHEELER`, and India is one of the regions it is offered in. The field
 * mask is the whole bill: Google charges by what is asked for, and the
 * agent app needs the line, the totals and the turn list — nothing else.
 */
export async function routeDirections(from: GeoPoint, to: GeoPoint, mode: DirectionsMode): Promise<Directions | null> {
  const key = await requireKey();
  let response: Response;
  try {
    response = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': ROUTES_FIELD_MASK,
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.latitude, longitude: from.longitude } } },
        destination: { location: { latLng: { latitude: to.latitude, longitude: to.longitude } } },
        travelMode: TRAVEL_MODES[mode],
        languageCode: 'en-IN',
        units: 'METRIC',
      }),
    });
  } catch (cause) {
    logger.error('Google Routes unreachable', { err: cause });
    throw new ApiError(502, 'INTERNAL_ERROR', 'Google Maps could not be reached.');
  }

  const body = (await response.json().catch(() => ({}))) as RoutesResponse;
  if (!response.ok) {
    const status = body.error?.status;
    if (response.status === 403 || response.status === 401 || status === 'PERMISSION_DENIED') {
      logger.error('Google Routes refused the key', { message: body.error?.message });
      throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Google Maps refused the request. Check the key and its API restrictions.');
    }
    if (response.status === 429 || status === 'RESOURCE_EXHAUSTED') {
      throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Google Maps quota is exhausted. Try again shortly.');
    }
    if (response.status === 400) {
      throw new ApiError(400, 'BAD_REQUEST', body.error?.message ?? 'Google Maps rejected the request.');
    }
    logger.error('Google Routes unexpected status', { http: response.status, status, message: body.error?.message });
    throw new ApiError(502, 'INTERNAL_ERROR', `Google Maps answered HTTP ${response.status}.`);
  }

  const route = body.routes?.[0];
  if (!route?.polyline?.encodedPolyline) return null;
  const steps = (route.legs ?? []).flatMap((leg) => leg.steps ?? []);
  return {
    polyline: route.polyline.encodedPolyline,
    distanceM: route.distanceMeters ?? 0,
    durationS: seconds(route.duration),
    steps: steps.map((step) => ({
      instruction: step.navigationInstruction?.instructions ?? null,
      distanceM: step.distanceMeters ?? 0,
      durationS: seconds(step.staticDuration),
      polyline: step.polyline?.encodedPolyline ?? null,
    })),
    mode,
    modeUsed: mode,
    provider: 'GOOGLE',
  };
}

export const googleMapsProvider: MapsProvider = {
  name: 'GOOGLE',
  geocode: geocodeAddress,
  reverse: reverseGeocode,
  autocomplete: autocompletePlaces,
  placeDetails,
  directions: routeDirections,
};
