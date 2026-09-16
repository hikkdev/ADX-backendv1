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
 * Mapbox, behind the maps seam — G7 (Q101): "maps must not be Google-only;
 * add a good affordable alternative behind the seam".
 *
 * Three Mapbox surfaces answer the port's five lookups:
 *
 *   - Geocoding v6 (`/search/geocode/v6/forward`, `/reverse`) for an address
 *     as typed and for coordinates → address.
 *   - Search Box v1 (`/search/searchbox/v1/suggest`, `/retrieve/:id`) for the
 *     typed fragment → candidates → chosen point. It is the Mapbox surface
 *     with a session token, and the seam's autocomplete contract (predictions
 *     carry no coordinates; the pick is a second call under the same session)
 *     is exactly the Search Box billing model, so a search bills once here
 *     the way it does on Google.
 *   - Directions v5 (`/directions/v5/mapbox/driving`) for the route. Mapbox
 *     has no motorcycle profile, so Q137's `two_wheeler` is answered with
 *     `driving` and `modeUsed` says so — the agent app draws the line either
 *     way and prints the mode it got.
 *
 * The token is the SECRET one (`sk.`, `getEffectiveMapsConfig().mapboxSecretToken`)
 * — the public `pk.` token is what `GET /app/maps` hands the phones for tiles
 * and never spends server-side quota. Every answer is normalised here so
 * nothing above this file knows Mapbox's shapes: `context` becomes city /
 * state / postal code, `[lng, lat]` becomes `latitude` / `longitude`, and
 * an HTTP status becomes the same ApiError vocabulary Google's adapter
 * speaks.
 */

const GEOCODE_FORWARD_URL = 'https://api.mapbox.com/search/geocode/v6/forward';
const GEOCODE_REVERSE_URL = 'https://api.mapbox.com/search/geocode/v6/reverse';
const SUGGEST_URL = 'https://api.mapbox.com/search/searchbox/v1/suggest';
const RETRIEVE_URL = 'https://api.mapbox.com/search/searchbox/v1/retrieve';
const DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox';

/** Results are limited to India; the platform sells nowhere else yet. */
const COUNTRY = 'in';
const LANGUAGE = 'en';

/* ------------------------------------------------------------------ */
/* Mapbox's shapes — confined to this file                             */
/* ------------------------------------------------------------------ */

/** Geocoding v6 and Search Box retrieve share this `properties.context`. */
type MapboxContext = {
  address?: { name?: string; address_number?: string; street_name?: string };
  street?: { name?: string };
  postcode?: { name?: string };
  locality?: { name?: string };
  place?: { name?: string };
  district?: { name?: string };
  region?: { name?: string; region_code?: string };
  country?: { name?: string; country_code?: string };
};

type MapboxFeature = {
  id?: string;
  geometry?: { type?: string; coordinates?: [number, number] };
  properties?: {
    mapbox_id?: string;
    name?: string;
    name_preferred?: string;
    full_address?: string;
    place_formatted?: string;
    feature_type?: string;
    coordinates?: { longitude?: number; latitude?: number };
    context?: MapboxContext;
  };
};

type FeatureCollection = { type?: string; features?: MapboxFeature[]; message?: string };

type SuggestResponse = {
  suggestions?: {
    mapbox_id: string;
    name: string;
    name_preferred?: string;
    full_address?: string;
    place_formatted?: string;
    feature_type?: string;
    context?: MapboxContext;
  }[];
  message?: string;
};

/** Directions v5 with `geometries=polyline&steps=true`. */
type DirectionsResponse = {
  code?: string;
  message?: string;
  routes?: {
    distance?: number;
    duration?: number;
    /** Encoded polyline, precision 5. */
    geometry?: string;
    legs?: {
      steps?: {
        distance?: number;
        duration?: number;
        geometry?: string;
        maneuver?: { instruction?: string; type?: string };
      }[];
    }[];
  }[];
};

/** Q137: Mapbox's profiles for the two modes the agent app offers — `driving` for both. */
const PROFILES: Record<DirectionsMode, { profile: 'driving'; used: DirectionsMode }> = {
  driving: { profile: 'driving', used: 'driving' },
  two_wheeler: { profile: 'driving', used: 'driving' },
};

/* ------------------------------------------------------------------ */
/* The one call, and the one status table                             */
/* ------------------------------------------------------------------ */

/** Internal: a 404 from Mapbox, caught by the lookup that expects one. */
class NotFoundSignal extends Error {}

async function requireToken(): Promise<string> {
  const { mapboxSecretToken } = await getEffectiveMapsConfig();
  const token = mapboxSecretToken?.trim();
  if (!token) {
    throw new ApiError(
      503,
      'INTEGRATION_NOT_CONFIGURED',
      'Mapbox is not configured: no secret token is set.',
    );
  }
  return token;
}

/**
 * Calls Mapbox and turns its HTTP status into an answer or an ApiError.
 *
 * Mapbox speaks HTTP rather than a status word: 401 / 403 is a token it
 * refuses (503, the same code as no token, because to a screen it is the
 * same problem), 429 is the rate limit, 400 / 422 is a malformed request
 * (the caller's 400), anything else 5xx-ish is Mapbox being down (502).
 * An empty feature list is the caller's null, never an error.
 */
async function call<T extends { message?: string }>(url: URL, what: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch (cause) {
    logger.error('Mapbox unreachable', { what, err: cause });
    throw new ApiError(502, 'INTERNAL_ERROR', 'Mapbox could not be reached.');
  }
  const body = (await response.json().catch(() => ({}))) as T;
  if (response.ok) return body;
  if (response.status === 401 || response.status === 403) {
    logger.error('Mapbox refused the token', { what, message: body.message });
    throw new ApiError(
      503,
      'INTEGRATION_NOT_CONFIGURED',
      'Mapbox refused the request. Check the secret token and its scopes.',
    );
  }
  if (response.status === 429) {
    throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Mapbox rate limit reached. Try again shortly.');
  }
  if (response.status === 400 || response.status === 422) {
    throw new ApiError(400, 'BAD_REQUEST', body.message ?? 'Mapbox rejected the request.');
  }
  if (response.status === 404) {
    // Search Box retrieve for a dead id; the caller turns it into its own 404.
    throw new NotFoundSignal();
  }
  logger.error('Mapbox unexpected status', { what, http: response.status, message: body.message });
  throw new ApiError(502, 'INTERNAL_ERROR', `Mapbox answered HTTP ${response.status}.`);
}

function withToken(url: URL, token: string): URL {
  url.searchParams.set('access_token', token);
  return url;
}

/**
 * Mapbox's `context` → the listing's three fields. An Indian address files
 * its city under `place`; where Mapbox knows only the locality or the
 * district, that is the next best thing to call a city.
 */
function toPlace(feature: MapboxFeature): GeocodedPlace | null {
  const props = feature.properties ?? {};
  const [lng, lat] = feature.geometry?.coordinates ?? [props.coordinates?.longitude, props.coordinates?.latitude];
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  const ctx = props.context ?? {};
  const formatted = props.full_address ?? [props.name, props.place_formatted].filter(Boolean).join(', ');
  return {
    formattedAddress: formatted,
    latitude: lat,
    longitude: lng,
    placeId: props.mapbox_id ?? feature.id ?? null,
    city: ctx.place?.name ?? ctx.locality?.name ?? ctx.district?.name ?? null,
    state: ctx.region?.name ?? null,
    postalCode: ctx.postcode?.name ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Geocoding v6                                                        */
/* ------------------------------------------------------------------ */

/** An address as typed → the best match, or null when nothing matches. */
export async function geocodeAddress(address: string): Promise<GeocodedPlace | null> {
  const token = await requireToken();
  const url = new URL(GEOCODE_FORWARD_URL);
  url.searchParams.set('q', address);
  url.searchParams.set('country', COUNTRY);
  url.searchParams.set('language', LANGUAGE);
  url.searchParams.set('limit', '1');
  const body = await call<FeatureCollection>(withToken(url, token), 'geocode');
  const first = body.features?.[0];
  return first ? toPlace(first) : null;
}

/** Coordinates → the most specific address Mapbox has for them, or null. */
export async function reverseGeocode(point: GeoPoint): Promise<GeocodedPlace | null> {
  const token = await requireToken();
  const url = new URL(GEOCODE_REVERSE_URL);
  url.searchParams.set('longitude', String(point.longitude));
  url.searchParams.set('latitude', String(point.latitude));
  url.searchParams.set('language', LANGUAGE);
  url.searchParams.set('limit', '1');
  const body = await call<FeatureCollection>(withToken(url, token), 'reverse-geocode');
  const first = body.features?.[0];
  return first ? toPlace(first) : null;
}

/* ------------------------------------------------------------------ */
/* Search Box v1 — the session-billed search                           */
/* ------------------------------------------------------------------ */

/**
 * A typed fragment → candidate places, India only.
 *
 * Search Box requires a session token; when the client sent none, one is
 * minted per call — every keystroke then bills on its own, which is what
 * the client asked for by not minting one.
 */
export async function autocompletePlaces(
  input: string,
  options: AutocompleteOptions = {},
): Promise<PlacePrediction[]> {
  const token = await requireToken();
  const url = new URL(SUGGEST_URL);
  url.searchParams.set('q', input);
  url.searchParams.set('country', COUNTRY);
  url.searchParams.set('language', LANGUAGE);
  url.searchParams.set('limit', '5');
  url.searchParams.set('session_token', options.sessionToken ?? crypto.randomUUID());
  if (options.near) {
    url.searchParams.set('proximity', `${options.near.longitude},${options.near.latitude}`);
  }
  const body = await call<SuggestResponse>(withToken(url, token), 'autocomplete');
  return (body.suggestions ?? []).map((s) => {
    const secondary = s.place_formatted ?? s.full_address ?? null;
    return {
      placeId: s.mapbox_id,
      description: s.full_address ?? [s.name, s.place_formatted].filter(Boolean).join(', '),
      mainText: s.name_preferred ?? s.name,
      secondaryText: secondary,
    };
  });
}

/** A chosen prediction → its coordinates and address, or null for a dead id. */
export async function placeDetails(
  placeId: string,
  sessionToken?: string,
): Promise<(GeocodedPlace & { name: string | null }) | null> {
  const token = await requireToken();
  const url = new URL(`${RETRIEVE_URL}/${encodeURIComponent(placeId)}`);
  url.searchParams.set('session_token', sessionToken ?? crypto.randomUUID());
  url.searchParams.set('language', LANGUAGE);
  let body: FeatureCollection;
  try {
    body = await call<FeatureCollection>(withToken(url, token), 'place-details');
  } catch (err) {
    if (err instanceof NotFoundSignal) return null;
    throw err;
  }
  const first = body.features?.[0];
  const place = first ? toPlace(first) : null;
  if (!place) return null;
  return { ...place, name: first?.properties?.name ?? null };
}

/* ------------------------------------------------------------------ */
/* Directions v5                                                       */
/* ------------------------------------------------------------------ */

/**
 * A route from `from` to `to`, or null when Mapbox finds none.
 *
 * `geometries=polyline` is Google's precision-5 encoding, so the agent app
 * decodes both vendors' lines with one decoder. `overview=full` because the
 * line is drawn, not summarised; `steps=true` for the turn list.
 */
export async function routeDirections(from: GeoPoint, to: GeoPoint, mode: DirectionsMode): Promise<Directions | null> {
  const token = await requireToken();
  const { profile, used } = PROFILES[mode];
  const coordinates = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const url = new URL(`${DIRECTIONS_URL}/${profile}/${coordinates}`);
  url.searchParams.set('geometries', 'polyline');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('steps', 'true');
  url.searchParams.set('language', LANGUAGE);
  const body = await call<DirectionsResponse>(withToken(url, token), 'directions');
  // Mapbox answers 200 with a code for "asked correctly, nothing there".
  if (body.code === 'NoRoute' || body.code === 'NoSegment') return null;
  if (body.code && body.code !== 'Ok') {
    logger.error('Mapbox Directions unexpected code', { code: body.code, message: body.message });
    throw new ApiError(502, 'INTERNAL_ERROR', `Mapbox answered ${body.code}.`);
  }
  const route = body.routes?.[0];
  if (!route?.geometry) return null;
  const steps = (route.legs ?? []).flatMap((leg) => leg.steps ?? []);
  return {
    polyline: route.geometry,
    distanceM: Math.round(route.distance ?? 0),
    durationS: Math.round(route.duration ?? 0),
    steps: steps.map((step) => ({
      instruction: step.maneuver?.instruction ?? null,
      distanceM: Math.round(step.distance ?? 0),
      durationS: Math.round(step.duration ?? 0),
      polyline: step.geometry ?? null,
    })),
    mode,
    modeUsed: used,
    provider: 'MAPBOX',
  };
}

export const mapboxMapsProvider: MapsProvider = {
  name: 'MAPBOX',
  geocode: geocodeAddress,
  reverse: reverseGeocode,
  autocomplete: autocompletePlaces,
  placeDetails,
  directions: routeDirections,
};
