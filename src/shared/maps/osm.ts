import { redis } from '../cache/redis';
import { ApiError } from '../errors';
import { getEffectiveMapsConfig, isPublicNominatim, type ResolvedOsmConfig } from '../integrations';
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
 * OpenStreetMap, behind the maps seam — Z-B (the owner, 15 Sep 2026: "In
 * maps, let's integrate OpenStreetMap besides Google and Mapbox").
 *
 * Three OSM-based services answer the port's five lookups, every one of
 * them a configurable base URL on the integrations row (`maps.osm`):
 *
 *   - Nominatim (`/search`, `/reverse`, `/lookup`) for an address as typed,
 *     coordinates → address, and a chosen prediction → its point. The
 *     public instance (nominatim.openstreetmap.org) has a USAGE POLICY this
 *     adapter keeps: at most ONE request a second (a Redis bucket, per
 *     platform, not per instance), a User-Agent naming the app and a
 *     contact email (which is why `contactEmail` is required to select
 *     OSM), no bulk geocoding. A self-hosted or commercial Nominatim on
 *     `nominatimBaseUrl` is not metered by us.
 *   - Photon (`/api`, komoot's OSM search-as-you-type) for the typed
 *     fragment → candidates. Photon returns coordinates, but the seam's
 *     contract is that predictions carry none: the pick is `placeDetails`
 *     with the prediction's `osm_type` + `osm_id`, answered by Nominatim's
 *     `/lookup`, so every screen works the same way it does on Google.
 *   - OSRM (`/route/v1/{profile}`) for the route. The public demo router
 *     (router.project-osrm.org) is FOR TESTING ONLY and serves the car
 *     profile — production points `osrmBaseUrl` at a self-hosted OSRM or
 *     an OSRM-compatible host. Q137's `two_wheeler` is answered with
 *     `driving` and `modeUsed` says so, the way Mapbox does.
 *
 * No key anywhere here: `tileApiKey` is for tiles, which the clients draw
 * through `GET /app/maps`. Every answer is normalised so nothing above this
 * file knows OSM's shapes, and HTTP statuses become the same ApiError
 * vocabulary Google's and Mapbox's adapters speak: a 403 / 429 from
 * Nominatim is 429 with the policy sentence (there is no key to refuse, so
 * a refusal is the policy, not a credential), a malformed request 400, a
 * network failure or an unexpected status 502, an empty array null.
 */

/** Results are limited to India; the platform sells nowhere else yet. */
const COUNTRY = 'in';
const LANGUAGE = 'en';
/** India's bounding box for Photon (`bbox=minLon,minLat,maxLon,maxLat`). */
const INDIA_BBOX = '68.1,6.5,97.4,35.7';
/** Every OSM call gives up after this long; the vendor being slow is the vendor being down. */
export const OSM_TIMEOUT_MS = 8_000;

/**
 * The public Nominatim bucket: ONE token, refilled every second, shared by
 * every instance through Redis. `SET NX PX 1000` is that bucket exactly —
 * the key exists while the second's token is spent.
 */
export const NOMINATIM_BUCKET_KEY = 'maps:osm:nominatim:public';
const NOMINATIM_BUCKET_WINDOW_MS = 1_000;
export const NOMINATIM_POLICY_SENTENCE =
  'The public Nominatim allows one request a second per application; wait a moment, or point nominatimBaseUrl at your own Nominatim.';

/* ------------------------------------------------------------------ */
/* OSM's shapes — confined to this file                                */
/* ------------------------------------------------------------------ */

/** Nominatim `format=jsonv2` with `addressdetails=1`; `/reverse` answers one object, `/search` and `/lookup` an array. */
type NominatimPlace = {
  message?: string;
  place_id?: number;
  osm_type?: 'node' | 'way' | 'relation';
  osm_id?: number;
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  error?: string | { code?: number; message?: string };
  address?: {
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    city_district?: string;
    suburb?: string;
    county?: string;
    state_district?: string;
    state?: string;
    postcode?: string;
    country_code?: string;
  };
};

/** Photon answers GeoJSON features; the properties carry the OSM id and the address parts. */
type PhotonResponse = {
  features?: {
    geometry?: { coordinates?: [number, number] };
    properties?: {
      osm_type?: 'N' | 'W' | 'R';
      osm_id?: number;
      name?: string;
      street?: string;
      housenumber?: string;
      district?: string;
      city?: string;
      county?: string;
      state?: string;
      postcode?: string;
      country?: string;
      countrycode?: string;
    };
  }[];
  message?: string;
};

/** OSRM `/route/v1` with `geometries=geojson&overview=full&steps=true`. */
type OsrmResponse = {
  code?: string;
  message?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: { type?: string; coordinates?: [number, number][] };
    legs?: {
      steps?: {
        distance?: number;
        duration?: number;
        name?: string;
        geometry?: { coordinates?: [number, number][] };
        maneuver?: { type?: string; modifier?: string };
      }[];
    }[];
  }[];
};

/** Q137: OSRM's profiles for the two modes the agent app offers — `driving` for both; the demo router serves only the car profile. */
const PROFILES: Record<DirectionsMode, { profile: 'driving'; used: DirectionsMode }> = {
  driving: { profile: 'driving', used: 'driving' },
  two_wheeler: { profile: 'driving', used: 'driving' },
};

/* ------------------------------------------------------------------ */
/* The one call, the bucket, and the one status table                  */
/* ------------------------------------------------------------------ */

/** Internal: a 404 from the vendor, caught by the lookup that expects one. */
class NotFoundSignal extends Error {}

async function osmConfig(): Promise<ResolvedOsmConfig> {
  return (await getEffectiveMapsConfig()).osm;
}

/**
 * Takes the second's token from the public Nominatim bucket, or answers 429.
 * Only the public host is metered: a host of ops' own has whatever limit
 * ops gave it. Redis being down lets the call through — the policy is
 * ours to keep, and a lost lock is a lost token, not a lost lookup.
 */
async function takeNominatimToken(baseUrl: string): Promise<void> {
  if (!isPublicNominatim(baseUrl)) return;
  let granted: string | null;
  try {
    granted = await redis.set(NOMINATIM_BUCKET_KEY, '1', 'PX', NOMINATIM_BUCKET_WINDOW_MS, 'NX');
  } catch (cause) {
    logger.warn('Nominatim bucket unavailable — letting the call through', { err: cause });
    return;
  }
  if (granted !== 'OK') {
    throw new ApiError(429, 'TOO_MANY_REQUESTS', NOMINATIM_POLICY_SENTENCE);
  }
}

/**
 * Calls an OSM service and turns its HTTP status into an answer or an ApiError.
 *
 * There is no key to be refused, so 401 / 403 / 429 are the vendor's policy
 * (Nominatim blocks a User-Agent it dislikes with 403 and a rate it dislikes
 * with 429) and all become 429 with the policy sentence; 400 / 422 is the
 * caller's 400; 404 is the lookup's own null; anything else is the vendor
 * being down (502), and so is a network failure or the 8 s timeout.
 */
async function call<T extends { message?: string }>(
  url: URL,
  what: string,
  userAgent: string,
  options: { tolerate400?: boolean } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { 'User-Agent': userAgent, 'Accept-Language': LANGUAGE, Accept: 'application/json' },
      signal: AbortSignal.timeout(OSM_TIMEOUT_MS),
    });
  } catch (cause) {
    logger.error('OpenStreetMap service unreachable', { what, host: url.hostname, err: cause });
    throw new ApiError(502, 'INTERNAL_ERROR', `${what === 'directions' ? 'OSRM' : 'Nominatim'} could not be reached.`);
  }
  const body = (await response.json().catch(() => ({}))) as T;
  if (response.ok) return body;
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    logger.warn('OpenStreetMap service refused the request', { what, host: url.hostname, http: response.status, message: body.message });
    throw new ApiError(429, 'TOO_MANY_REQUESTS', NOMINATIM_POLICY_SENTENCE);
  }
  if (response.status === 400 && options.tolerate400) return body;
  if (response.status === 400 || response.status === 422) {
    throw new ApiError(400, 'BAD_REQUEST', body.message ?? 'The maps service rejected the request.');
  }
  if (response.status === 404) throw new NotFoundSignal();
  logger.error('OpenStreetMap service unexpected status', { what, host: url.hostname, http: response.status, message: body.message });
  throw new ApiError(502, 'INTERNAL_ERROR', `The maps service answered HTTP ${response.status}.`);
}

/**
 * Nominatim's `address` → the listing's three fields. An Indian address
 * files its city under `city`, `town` or `village`; where Nominatim knows
 * only the district, that is the next best thing to call a city.
 */
function toPlace(place: NominatimPlace): GeocodedPlace | null {
  const lat = Number(place.lat);
  const lng = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !place.display_name) return null;
  const a = place.address ?? {};
  return {
    formattedAddress: place.display_name,
    latitude: lat,
    longitude: lng,
    placeId: osmPlaceId(place.osm_type, place.osm_id),
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? a.city_district ?? a.state_district ?? a.county ?? null,
    state: a.state ?? null,
    postalCode: a.postcode ?? null,
  };
}

/** The seam's placeId for an OSM object: `N123` / `W456` / `R789` — exactly what Nominatim's `/lookup` takes. */
function osmPlaceId(type: string | undefined, id: number | undefined): string | null {
  if (!type || typeof id !== 'number') return null;
  const letter = type[0]?.toUpperCase();
  return letter === 'N' || letter === 'W' || letter === 'R' ? `${letter}${id}` : null;
}

const PLACE_ID_PATTERN = /^[NWR]\d{1,20}$/;

/**
 * GeoJSON `[lng, lat][]` → Google's precision-5 encoded polyline, so the
 * agent app decodes every vendor's line with one decoder. OSRM can emit the
 * encoding itself, but GeoJSON is what every OSRM-compatible host speaks.
 */
export function encodePolyline(coordinates: [number, number][]): string {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  const encode = (value: number): void => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const [lng, lat] of coordinates) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    encode(latE5 - prevLat);
    encode(lngE5 - prevLng);
    prevLat = latE5;
    prevLng = lngE5;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Nominatim                                                           */
/* ------------------------------------------------------------------ */

async function nominatim<T extends { message?: string }>(path: string, params: Record<string, string>, what: string): Promise<T> {
  const cfg = await osmConfig();
  await takeNominatimToken(cfg.nominatimBaseUrl);
  const url = new URL(`${cfg.nominatimBaseUrl}${path}`);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', LANGUAGE);
  if (cfg.contactEmail) url.searchParams.set('email', cfg.contactEmail);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return call<T>(url, what, cfg.userAgent);
}

/** An address as typed → the best match, or null when nothing matches. */
export async function geocodeAddress(address: string): Promise<GeocodedPlace | null> {
  const body = await nominatim<NominatimPlace[] & { message?: string }>(
    '/search',
    { q: address, countrycodes: COUNTRY, limit: '1' },
    'geocode',
  );
  const first = Array.isArray(body) ? body[0] : undefined;
  return first ? toPlace(first) : null;
}

/** Coordinates → the most specific address Nominatim has for them, or null. */
export async function reverseGeocode(point: GeoPoint): Promise<GeocodedPlace | null> {
  const body = await nominatim<NominatimPlace>(
    '/reverse',
    { lat: String(point.latitude), lon: String(point.longitude), zoom: '18' },
    'reverse-geocode',
  );
  // Nominatim answers 200 with `{ error: 'Unable to geocode' }` for open sea.
  if (!body || body.error) return null;
  return toPlace(body);
}

/** A chosen prediction (`N123` / `W456` / `R789`) → its coordinates and address, or null for a dead id. */
export async function placeDetails(
  placeId: string,
  _sessionToken?: string,
): Promise<(GeocodedPlace & { name: string | null }) | null> {
  if (!PLACE_ID_PATTERN.test(placeId)) return null;
  let body: NominatimPlace[] & { message?: string };
  try {
    body = await nominatim<NominatimPlace[] & { message?: string }>('/lookup', { osm_ids: placeId }, 'place-details');
  } catch (err) {
    if (err instanceof NotFoundSignal) return null;
    throw err;
  }
  const first = Array.isArray(body) ? body[0] : undefined;
  const place = first ? toPlace(first) : null;
  if (!place) return null;
  return { ...place, name: first?.name || null };
}

/* ------------------------------------------------------------------ */
/* Photon — search as you type                                         */
/* ------------------------------------------------------------------ */

/**
 * A typed fragment → candidate places, India only. Photon has no session
 * and bills nothing, so `sessionToken` is accepted and ignored; `near`
 * biases the ranking (`lat`/`lon`), the bbox keeps the answers in India.
 */
export async function autocompletePlaces(input: string, options: AutocompleteOptions = {}): Promise<PlacePrediction[]> {
  const cfg = await osmConfig();
  const url = new URL(`${cfg.photonBaseUrl}/api`);
  url.searchParams.set('q', input);
  url.searchParams.set('lang', LANGUAGE);
  url.searchParams.set('limit', '5');
  url.searchParams.set('bbox', INDIA_BBOX);
  if (options.near) {
    url.searchParams.set('lat', String(options.near.latitude));
    url.searchParams.set('lon', String(options.near.longitude));
  }
  const body = await call<PhotonResponse>(url, 'autocomplete', cfg.userAgent);
  const predictions: PlacePrediction[] = [];
  for (const feature of body.features ?? []) {
    const p = feature.properties ?? {};
    const placeId = osmPlaceId(p.osm_type, p.osm_id);
    if (!placeId) continue;
    const main = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || p.state;
    if (!main) continue;
    const secondaryParts = [p.street && p.name ? p.street : null, p.district, p.city, p.state, p.postcode].filter(
      (part, index, all): part is string => Boolean(part) && part !== main && all.indexOf(part) === index,
    );
    const secondary = secondaryParts.length ? secondaryParts.join(', ') : null;
    predictions.push({
      placeId,
      description: secondary ? `${main}, ${secondary}` : main,
      mainText: main,
      secondaryText: secondary,
    });
  }
  return predictions;
}

/* ------------------------------------------------------------------ */
/* OSRM                                                                */
/* ------------------------------------------------------------------ */

/**
 * A route from `from` to `to`, or null when OSRM finds none.
 *
 * `geometries=geojson` because every OSRM-compatible host speaks it; the
 * line is encoded to precision-5 polyline here so the agent app keeps one
 * decoder. `overview=full` because the line is drawn, not summarised;
 * `steps=true` for the turn list — OSRM has no instruction text, so a
 * step's instruction is its manoeuvre and road name.
 */
export async function routeDirections(from: GeoPoint, to: GeoPoint, mode: DirectionsMode): Promise<Directions | null> {
  const cfg = await osmConfig();
  const { profile, used } = PROFILES[mode];
  const coordinates = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const url = new URL(`${cfg.osrmBaseUrl}/route/v1/${profile}/${coordinates}`);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('steps', 'true');
  let body: OsrmResponse;
  try {
    // OSRM answers HTTP 400 with a code for "asked correctly, nothing there" — the code decides, not the status.
    body = await call<OsrmResponse>(url, 'directions', cfg.userAgent, { tolerate400: true });
  } catch (err) {
    if (err instanceof NotFoundSignal) return null;
    throw err;
  }
  if (body.code === 'NoRoute' || body.code === 'NoSegment') return null;
  if (body.code && body.code !== 'Ok') {
    if (/^(Invalid|TooBig|NoTable|NotImplemented)/.test(body.code)) {
      throw new ApiError(400, 'BAD_REQUEST', body.message ?? `OSRM rejected the request (${body.code}).`);
    }
    logger.error('OSRM unexpected code', { code: body.code, message: body.message });
    throw new ApiError(502, 'INTERNAL_ERROR', `OSRM answered ${body.code}.`);
  }
  const route = body.routes?.[0];
  const line = route?.geometry?.coordinates;
  if (!route || !line?.length) return null;
  const steps = (route.legs ?? []).flatMap((leg) => leg.steps ?? []);
  return {
    polyline: encodePolyline(line),
    distanceM: Math.round(route.distance ?? 0),
    durationS: Math.round(route.duration ?? 0),
    steps: steps.map((step) => ({
      instruction: stepInstruction(step.maneuver?.type, step.maneuver?.modifier, step.name),
      distanceM: Math.round(step.distance ?? 0),
      durationS: Math.round(step.duration ?? 0),
      polyline: step.geometry?.coordinates?.length ? encodePolyline(step.geometry.coordinates) : null,
    })),
    mode,
    modeUsed: used,
    provider: 'OSM',
  };
}

/** OSRM gives a manoeuvre, not a sentence: "Turn left onto MG Road". */
function stepInstruction(type: string | undefined, modifier: string | undefined, name: string | undefined): string | null {
  if (!type) return null;
  const verb = type === 'depart' ? 'Head' : type === 'arrive' ? 'Arrive' : type === 'turn' ? 'Turn' : type === 'continue' ? 'Continue' : type === 'roundabout' || type === 'rotary' ? 'Take the roundabout' : type === 'merge' ? 'Merge' : type === 'fork' ? 'Keep' : type === 'end of road' ? 'Turn' : type === 'new name' ? 'Continue' : type.charAt(0).toUpperCase() + type.slice(1);
  const parts = [verb];
  if (modifier && type !== 'arrive') parts.push(modifier);
  if (name) parts.push(type === 'arrive' ? `at ${name}` : `onto ${name}`);
  return parts.join(' ');
}

export const osmMapsProvider: MapsProvider = {
  name: 'OSM',
  geocode: geocodeAddress,
  reverse: reverseGeocode,
  autocomplete: autocompletePlaces,
  placeDetails,
  directions: routeDirections,
};
