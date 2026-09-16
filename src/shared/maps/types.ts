/**
 * The maps provider port — G7 (Q101/132/137).
 *
 * One vocabulary for every vendor so nothing above `shared/maps` knows whether
 * Google, Mapbox or OpenStreetMap (Z-B) answered: an address becomes a `GeocodedPlace`, a typed
 * fragment becomes `PlacePrediction`s, a chosen prediction becomes a point,
 * and two points become a `Directions` with an encoded polyline. The vendor
 * shapes stay inside `google.ts`, `mapbox.ts` and `osm.ts`.
 */

export type GeoPoint = { latitude: number; longitude: number };

export type GeocodedPlace = {
  formattedAddress: string;
  latitude: number;
  longitude: number;
  placeId: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

export type PlacePrediction = {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string | null;
};

export type AutocompleteOptions = {
  /** Groups the keystrokes of one search into one billable session. */
  sessionToken?: string;
  /** Bias toward here, in metres of radius. */
  near?: GeoPoint;
  radiusM?: number;
};

/**
 * Q137: the two ways an agent travels to a job. `two_wheeler` is a first-class
 * mode on Google's Routes API in India; Mapbox has no motorcycle profile and
 * answers it with its driving profile — `modeUsed` says which was honoured.
 */
export type MapsProviderName = 'GOOGLE' | 'MAPBOX' | 'OSM';

export type DirectionsMode = 'driving' | 'two_wheeler';
export const DIRECTIONS_MODES: readonly DirectionsMode[] = ['driving', 'two_wheeler'];

export type DirectionsStep = {
  instruction: string | null;
  distanceM: number;
  durationS: number;
  /** The step's own encoded polyline where the vendor gives one. */
  polyline: string | null;
};

export type Directions = {
  /** Encoded polyline (Google's precision-5 format, which Mapbox also emits and the OSM adapter encodes from OSRM's GeoJSON). */
  polyline: string;
  distanceM: number;
  durationS: number;
  steps: DirectionsStep[];
  mode: DirectionsMode;
  modeUsed: DirectionsMode;
  provider: MapsProviderName;
};

export interface MapsProvider {
  readonly name: MapsProviderName;
  /** An address as typed → the best match, or null when nothing matches. */
  geocode(address: string): Promise<GeocodedPlace | null>;
  /** Coordinates → the most specific address known for them, or null. */
  reverse(point: GeoPoint): Promise<GeocodedPlace | null>;
  /** A typed fragment → candidate places, India only; no coordinates by design. */
  autocomplete(input: string, options?: AutocompleteOptions): Promise<PlacePrediction[]>;
  /** A chosen prediction → its coordinates and address, or null for a dead id. */
  placeDetails(placeId: string, sessionToken?: string): Promise<(GeocodedPlace & { name: string | null }) | null>;
  /** A route between two points, or null when the vendor finds none. */
  directions(from: GeoPoint, to: GeoPoint, mode: DirectionsMode): Promise<Directions | null>;
}
