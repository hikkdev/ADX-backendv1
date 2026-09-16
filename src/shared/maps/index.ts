/**
 * The maps seam — G7 (Q101/132/137).
 *
 * One provider at a time, chosen on `/settings/integrations` (`maps.provider`,
 * Google unless ops chose Mapbox or — Z-B — OpenStreetMap). Callers name the lookup they want —
 * `geocodeAddress`, `routeDirections` — and never the vendor; the row
 * decides at call time, so switching provider is a form change, not a
 * deploy, and a deployment that never opened the section keeps geocoding
 * through Google the way it always did.
 *
 * All three adapters speak the same ApiError vocabulary: no key / refused key is
 * 503 `INTEGRATION_NOT_CONFIGURED`, quota (or, on OSM, the public usage
 * policy) is 429, a malformed request is 400, the vendor being down is 502,
 * and "asked correctly, nothing there" is null.
 *
 * AC-B1 (the owner, 16 Sep 2026): the phones keep the Mapbox engine
 * (`@rnmapbox/maps`, impl 'mapbox') whatever the provider. The phones draw
 * OSM tiles through the Mapbox SDK, which needs the public token to
 * initialise; the console and the backend never do — the console draws the
 * raster template straight into Leaflet / MapLibre, the backend geocodes
 * through Nominatim. So the OSM member of `GET /app/maps` carries the
 * Mapbox PUBLIC token beside the tile line (null when none is stored) and
 * `engineReady`, true only when both the template and the token are there.
 * The secret token never leaves the server on any branch.
 */
import { getEffectiveMapsConfig, type ResolvedOsmConfig } from '../integrations';
import { googleMapsProvider } from './google';
import { mapboxMapsProvider } from './mapbox';
import { osmMapsProvider } from './osm';
import type { AutocompleteOptions, DirectionsMode, GeoPoint, MapsProvider } from './types';

export * from './types';
export { googleMapsProvider } from './google';
export { mapboxMapsProvider } from './mapbox';
export { osmMapsProvider, NOMINATIM_BUCKET_KEY, NOMINATIM_POLICY_SENTENCE, OSM_TIMEOUT_MS } from './osm';

const PROVIDERS: Record<MapsProvider['name'], MapsProvider> = {
  GOOGLE: googleMapsProvider,
  MAPBOX: mapboxMapsProvider,
  OSM: osmMapsProvider,
};

/** The adapter the integrations row names right now. */
export async function getMapsProvider(): Promise<MapsProvider> {
  const { provider } = await getEffectiveMapsConfig();
  return PROVIDERS[provider] ?? googleMapsProvider;
}

/**
 * The client-side half of the seam — what `GET /app/maps` answers. The
 * browser key / public token only: a phone draws tiles with it and it is
 * restricted by bundle id or referrer on the vendor's side. The server
 * key never appears here, and this is the one place that rule is kept.
 * AC-B1: the OSM member carries the Mapbox PUBLIC token too — the phones'
 * SDK cannot start without one even when every tile comes from OSM.
 */
export type MapsClientConfig =
  | { provider: 'GOOGLE'; googleBrowserKey: string | null }
  | { provider: 'MAPBOX'; mapboxPublicToken: string | null }
  | {
      provider: 'OSM';
      /** The raster tile template (`{z}/{x}/{y}`), the tile key already in it for a public-safe host. */
      tileUrlTemplate: string;
      /** Mandatory on every map: "(c) OpenStreetMap contributors". */
      tileAttribution: string;
      tileMaxZoom: number;
      /** True while the template still names the public OSM tile server, whose policy forbids heavy app use. */
      publicTiles: boolean;
      /** AC-B1: the Mapbox PUBLIC token the phones initialise `@rnmapbox/maps` with before drawing the OSM raster; null while none is stored. Never the secret. */
      mapboxPublicToken: string | null;
      /** AC-B1: template present AND public token present — the phones can start their map. The console needs only the template. */
      engineReady: boolean;
    };

/**
 * Z-B: the OSM tile hosts whose key is a BROWSER key by design — MapTiler,
 * Stadia, Thunderforest and Geoapify all issue keys meant to sit in a tile
 * URL on a phone, restricted by referrer / bundle on their side. Only for
 * these is `tileApiKey` put into the template the clients receive; for any
 * other host (a self-hosted stack, an unknown vendor) the key stays on the
 * server and the template is answered as stored, `{key}` and all, so a key
 * meant for the server is never published by mistake.
 */
export const OSM_PUBLIC_SAFE_TILE_HOSTS: readonly string[] = [
  'api.maptiler.com',
  'tiles.stadiamaps.com',
  'tile.thunderforest.com',
  'maps.geoapify.com',
];

function tileHost(template: string): string | null {
  try {
    return new URL(template.replace(/\{[^}]*\}/g, 'x')).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The tile template a client draws with: the key substituted for `{key}` or appended as `?key=` on a public-safe host, untouched otherwise. */
export function clientTileUrlTemplate(osm: Pick<ResolvedOsmConfig, 'tileUrlTemplate' | 'tileApiKey'>): string {
  const template = osm.tileUrlTemplate;
  const key = osm.tileApiKey;
  if (!key) return template;
  const host = tileHost(template);
  if (!host || !OSM_PUBLIC_SAFE_TILE_HOSTS.some((safe) => host === safe || host.endsWith(`.${safe}`))) return template;
  const encoded = encodeURIComponent(key);
  if (template.includes('{key}')) return template.split('{key}').join(encoded);
  return `${template}${template.includes('?') ? '&' : '?'}key=${encoded}`;
}

export async function getMapsClientConfig(): Promise<MapsClientConfig> {
  const cfg = await getEffectiveMapsConfig();
  if (cfg.provider === 'MAPBOX') {
    return { provider: 'MAPBOX', mapboxPublicToken: cfg.mapboxPublicToken?.trim() || null };
  }
  if (cfg.provider === 'OSM') {
    const tileUrlTemplate = clientTileUrlTemplate(cfg.osm);
    // AC-B1: the PUBLIC token only — `mapboxSecretToken` is never read here, so it cannot be a fallback.
    const mapboxPublicToken = cfg.mapboxPublicToken?.trim() || null;
    return {
      provider: 'OSM',
      tileUrlTemplate,
      tileAttribution: cfg.osm.tileAttribution,
      tileMaxZoom: cfg.osm.tileMaxZoom,
      publicTiles: cfg.osm.publicTiles,
      mapboxPublicToken,
      engineReady: tileUrlTemplate.trim().length > 0 && mapboxPublicToken !== null,
    };
  }
  return { provider: 'GOOGLE', googleBrowserKey: cfg.googleBrowserKey?.trim() || null };
}

/* The five lookups, provider-agnostic. */

export const geocodeAddress: MapsProvider['geocode'] = async (address) => (await getMapsProvider()).geocode(address);

export const reverseGeocode: MapsProvider['reverse'] = async (point: GeoPoint) => (await getMapsProvider()).reverse(point);

export const autocompletePlaces: MapsProvider['autocomplete'] = async (input: string, options?: AutocompleteOptions) =>
  (await getMapsProvider()).autocomplete(input, options);

export const placeDetails: MapsProvider['placeDetails'] = async (placeId: string, sessionToken?: string) =>
  (await getMapsProvider()).placeDetails(placeId, sessionToken);

export const routeDirections: MapsProvider['directions'] = async (from: GeoPoint, to: GeoPoint, mode: DirectionsMode) =>
  (await getMapsProvider()).directions(from, to, mode);
