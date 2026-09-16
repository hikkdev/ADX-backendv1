import { ApiError } from '../errors';
import { getEffectiveAudienceConfig } from '../integrations';
import { logger } from '../logging';
import { AUDIENCE_FIELD_PATTERN, type AudienceCatchment, type AudienceProvider, type AudienceShare, type AudienceVendorTest } from './types';

/**
 * GeoIQ, behind the audience seam — G7 (Q109); made to actually work in AC-B2.
 *
 * GeoIQ sells location variables from a catalogue (catalog.geoiq.io): each
 * account is sold a set of variable ids — footfall, population by age band,
 * gender split, household income bands, POI affinities — and the Data
 * Serving API answers those ids for a point and a radius:
 *
 *   POST {base}/getvariables     x-api-key: <key>
 *   { "lat": 12.97, "lng": 77.59, "radius": 500, "variables": "id1,id2" }
 *   → { "data": { "id1": 12345, "id2": 0.31, ... }, "status": 200 }
 *
 * The ids are per account, so the adapter cannot know them: ops map the
 * seam's field names to the ids they bought in `audience.geoiqVariables`
 * (`footfall.daily` → `w_footfall_daily`, `age.18_24` → `...`, and so on).
 * A field with no id is null — never guessed. GeoIQ's catalogue is static
 * (no hourly or weekday panel, no month parameter), so `byHour` and
 * `byWeekday` are always null here and `period` is the cache key only.
 *
 * AC-B2 — what the live probe of 16 Sep 2026 taught:
 *
 *   - The host is regional: `dataserving-in.geoiq.io` for India (the
 *     default, `GEOIQ_DEFAULT_BASE_URL`), `dataserving-us.geoiq.io` for the
 *     US. The bare `dataserving.geoiq.io` does not resolve.
 *   - The host sits behind an API Gateway that answers HTTP 200 whatever
 *     happened, with the real answer as a JSON STRING under `body` and the
 *     real status as `statusCode` beside it:
 *       { "body": "{\"status\": 401, \"message\": \"You are not authorized …\", \"data\": null}", "statusCode": 401 }
 *     `unwrapGeoiqAnswer` parses that and the error table runs on the
 *     EFFECTIVE status — a 401 inside a 200 is still a refused key (503
 *     `INTEGRATION_NOT_CONFIGURED`, carrying GeoIQ's own sentence so ops
 *     read what GeoIQ said, and "contact GeoIQ" so they know whom to ask).
 *   - The docs bound a call: radius 100–2000 m (clamped here; the answer's
 *     `radiusM` says the circle actually asked about) and 50 variables a
 *     call (chunked here and the answers merged).
 *
 * Shares: a group whose values sum to about 1 is a fraction and is printed
 * as percent; a group that sums to about 100 is already percent. Nothing
 * else is rescaled — a count (an affinity POI count) is passed through.
 *
 * The key is a secret: it goes in the `x-api-key` header and nowhere else —
 * never in a log line, an error message or a verdict.
 */

export const GEOIQ_RADIUS_MIN_M = 100;
export const GEOIQ_RADIUS_MAX_M = 2000;
export const GEOIQ_MAX_VARIABLES_PER_CALL = 50;
/** The documented sample variable (total population) — what the key is tested with before any variable is mapped. */
export const GEOIQ_SAMPLE_VARIABLE = 'w_pop_tt';

/** GeoIQ's radius bound: 100–2000 m, whole metres. */
export function clampGeoiqRadius(radiusM: number): number {
  const rounded = Math.round(Number.isFinite(radiusM) ? radiusM : GEOIQ_RADIUS_MIN_M);
  return Math.min(GEOIQ_RADIUS_MAX_M, Math.max(GEOIQ_RADIUS_MIN_M, rounded));
}

/** Slices of at most `size`, in order. */
export function chunkVariables<T>(items: readonly T[], size = GEOIQ_MAX_VARIABLES_PER_CALL): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What one GeoIQ call means once the gateway envelope is off: the effective status, GeoIQ's message, the variables answered. */
export type GeoiqAnswer = { status: number; message: string | undefined; data: Record<string, unknown> | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asStatus = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null);
const asMessage = (record: Record<string, unknown>): string | undefined => {
  const m = record.message ?? record.error;
  return typeof m === 'string' && m.trim() !== '' ? m : undefined;
};

/**
 * Unwraps GeoIQ's answer. When the parsed body carries a string `body`
 * (the API Gateway envelope) the inner JSON is the answer and `statusCode`
 * (or the inner `status`) is the effective status even when the HTTP
 * status is 200. A plain answer's own numeric `status` counts the same
 * way; otherwise the HTTP status stands. `data` is the inner `data` when
 * it is an object; for a plain 2xx answer without a `data` key the answer
 * itself is read as the variable map (the first cut's tolerance, kept).
 */
export function unwrapGeoiqAnswer(httpStatus: number, raw: unknown): GeoiqAnswer {
  if (!isRecord(raw)) return { status: httpStatus, message: undefined, data: null };
  if (typeof raw.body === 'string') {
    let inner: unknown = null;
    try {
      inner = JSON.parse(raw.body);
    } catch {
      inner = null;
    }
    const innerRecord = isRecord(inner) ? inner : {};
    const status = asStatus(raw.statusCode) ?? asStatus(innerRecord.status) ?? httpStatus;
    return { status, message: asMessage(innerRecord), data: isRecord(innerRecord.data) ? innerRecord.data : null };
  }
  const status = asStatus(raw.status) ?? httpStatus;
  const message = asMessage(raw);
  if (isRecord(raw.data)) return { status, message, data: raw.data };
  if (status >= 200 && status < 300 && !('data' in raw)) {
    const { status: _s, message: _m, error: _e, ...rest } = raw;
    return { status, message, data: rest };
  }
  return { status, message, data: null };
}

/** GeoIQ's sentence, when it gave one, so ops read what GeoIQ said. */
const quoting = (message: string | undefined): string => (message ? ` GeoIQ said: "${message}"` : '');

/**
 * The error table over the EFFECTIVE status. Throws for everything but a
 * 2xx and a 404 (nothing for the circle — the caller reads `data: null`).
 */
export function throwForGeoiqStatus(answer: GeoiqAnswer): void {
  const { status, message } = answer;
  if (status >= 200 && status < 300) return;
  if (status === 404) return;
  if (status === 401 || status === 403) {
    logger.error('GeoIQ refused the key', { status, message });
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', `GeoIQ refused the request: not authorised — contact GeoIQ to enable the Data API on this key.${quoting(message)}`);
  }
  if (status === 429) throw new ApiError(429, 'TOO_MANY_REQUESTS', 'GeoIQ rate limit reached. Try again shortly.');
  if (status === 400 || status === 422) throw new ApiError(400, 'BAD_REQUEST', message ?? 'GeoIQ rejected the request.');
  logger.error('GeoIQ unexpected status', { status, message });
  throw new ApiError(502, 'INTERNAL_ERROR', `GeoIQ answered ${status}.${quoting(message)}`);
}

type GeoiqCredentials = { key: string; baseUrl: string };

/**
 * One call: the ids as a CSV, the key in the header, the envelope taken
 * off. Throws 502 when the host cannot be reached (the message names the
 * failure, never the key); every other outcome is returned for the caller
 * to judge, so the vendor test can print a refusal instead of throwing it.
 */
export async function callGeoiq(creds: GeoiqCredentials, lat: number, lng: number, radiusM: number, ids: readonly string[]): Promise<GeoiqAnswer> {
  let response: Response;
  try {
    response = await fetch(`${creds.baseUrl}/getvariables`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': creds.key },
      body: JSON.stringify({ lat, lng, radius: radiusM, variables: ids.join(',') }),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    logger.error('GeoIQ unreachable', { reason });
    throw new ApiError(502, 'INTERNAL_ERROR', `GeoIQ could not be reached: ${reason}`);
  }
  const raw = await response.json().catch(() => ({}));
  return unwrapGeoiqAnswer(response.status, raw);
}

/**
 * Every id, in chunks of at most 50 a call, the answers merged. Throws by
 * the error table; a 404 chunk contributes nothing. Null when no chunk had
 * anything.
 */
export async function geoiqGetVariables(creds: GeoiqCredentials, lat: number, lng: number, radiusM: number, ids: readonly string[]): Promise<Record<string, unknown> | null> {
  const merged: Record<string, unknown> = {};
  let anything = false;
  for (const chunk of chunkVariables(ids)) {
    const answer = await callGeoiq(creds, lat, lng, radiusM, chunk);
    throwForGeoiqStatus(answer);
    if (answer.data) {
      anything = true;
      Object.assign(merged, answer.data);
    }
  }
  return anything ? merged : null;
}

/** The mapped variables the seam recognises, as [field, id] pairs, in row order. */
function mappedVariables(map: Record<string, string> | undefined): [string, string][] {
  return Object.entries(map ?? {}).filter(([field, id]) => AUDIENCE_FIELD_PATTERN.test(field) && typeof id === 'string' && id.trim() !== '') as [string, string][];
}

async function requireConfig() {
  const cfg = await getEffectiveAudienceConfig();
  const key = cfg.geoiqApiKey?.trim();
  if (!key) {
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'GeoIQ is not configured: no API key is set.');
  }
  const variables = mappedVariables(cfg.geoiqVariables);
  if (variables.length === 0) {
    throw new ApiError(
      503,
      'INTEGRATION_NOT_CONFIGURED',
      'GeoIQ is not configured: no catalogue variables are mapped to the audience fields.',
    );
  }
  return { key, baseUrl: cfg.geoiqBaseUrl ?? '', variables };
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

/** `age.18_24` → `18_24`; the band the account named. */
const bandOf = (field: string): string => field.slice(field.indexOf('.') + 1);

/** A group of shares, normalised to percent when it is plainly a fraction. Null when nothing in the group came back. */
export function sharesFrom(entries: { label: string; value: number | null }[]): AudienceShare[] | null {
  const present = entries.filter((e): e is { label: string; value: number } => e.value !== null);
  if (present.length === 0) return null;
  const sum = present.reduce((acc, e) => acc + e.value, 0);
  const scale = sum > 0 && sum <= 1.001 ? 100 : 1;
  return present.map((e) => ({ label: e.label, share: Math.round(e.value * scale * 10) / 10 }));
}

export async function geoiqCatchment(lat: number, lng: number, radiusM: number, period: string): Promise<AudienceCatchment | null> {
  const { key, baseUrl, variables } = await requireConfig();
  const radius = clampGeoiqRadius(radiusM);
  const data = await geoiqGetVariables({ key, baseUrl }, lat, lng, radius, variables.map(([, id]) => id));
  if (!data) return null;

  const value = (field: string): number | null => {
    const id = variables.find(([f]) => f === field)?.[1];
    return id ? asNumber(data[id]) : null;
  };
  const group = (prefix: string): AudienceShare[] | null =>
    sharesFrom(variables.filter(([f]) => f.startsWith(`${prefix}.`)).map(([f]) => ({ label: bandOf(f), value: value(f) })));

  const footfallDaily = value('footfall.daily');
  const demographics = { ageBands: group('age'), gender: group('gender'), incomeBands: group('income'), affinities: group('affinity') };
  const anything = footfallDaily !== null || Object.values(demographics).some((g) => g !== null);
  if (!anything) return null;

  return {
    footfall: { daily: footfallDaily === null ? null : Math.round(footfallDaily), byHour: null, byWeekday: null },
    demographics,
    provenance: 'PANEL',
    vendor: 'GEOIQ',
    period,
    radiusM: radius,
    fetchedAt: new Date().toISOString(),
  };
}

export const geoiqAudienceProvider: AudienceProvider = { name: 'GEOIQ', catchment: geoiqCatchment };

/**
 * AC-B2: the vendor test behind the card. Asks GeoIQ ONCE at `point`, with
 * the mapped variables — or, when none are mapped, with the documented
 * sample `w_pop_tt`, so the KEY can be tested before the map exists — and
 * answers a verdict. Never throws for what GeoIQ did: no key, a refused
 * key, a dead host and a 5xx are all verdicts.
 */
export async function geoiqTest(point: { lat: number; lng: number }): Promise<AudienceVendorTest> {
  const cfg = await getEffectiveAudienceConfig();
  const key = cfg.geoiqApiKey?.trim();
  const variables = mappedVariables(cfg.geoiqVariables);
  const fields = variables.map(([field]) => field);
  const base: AudienceVendorTest = {
    vendor: 'GEOIQ',
    keyPresent: Boolean(key),
    variablesMapped: variables.length,
    reachable: false,
    authorized: false,
    status: null,
    message: '',
    fieldsAnswered: [],
    fieldsMissing: fields,
    sample: { footfallDaily: null },
  };
  if (!key) {
    return { ...base, fieldsMissing: [], message: 'GeoIQ has no API key set. Enter the Data API key and test again.' };
  }
  const radius = clampGeoiqRadius(cfg.catchmentRadiusM);
  const ids = variables.length > 0 ? variables.map(([, id]) => id) : [GEOIQ_SAMPLE_VARIABLE];
  let answer: GeoiqAnswer;
  try {
    // One call: the first 50 ids are enough to judge the key and the map.
    answer = await callGeoiq({ key, baseUrl: cfg.geoiqBaseUrl ?? '' }, point.lat, point.lng, radius, ids.slice(0, GEOIQ_MAX_VARIABLES_PER_CALL));
  } catch (err) {
    const reason = err instanceof ApiError ? err.message : 'GeoIQ could not be reached.';
    return { ...base, message: `${reason} Check the base URL (${cfg.geoiqBaseUrl ?? 'unset'}) and the network.` };
  }
  const { status, message, data } = answer;
  if (status === 401 || status === 403) {
    return {
      ...base,
      reachable: true,
      status,
      message: `GeoIQ refused the key: not authorised — contact GeoIQ to enable the Data API on this key.${quoting(message)}`,
    };
  }
  if (status < 200 || status >= 300) {
    const what = status === 429 ? 'GeoIQ rate limit reached; try again shortly.' : status === 404 ? 'GeoIQ had nothing for the test circle.' : `GeoIQ answered ${status}.`;
    return { ...base, reachable: true, authorized: true, status, message: `${what}${quoting(message)}` };
  }
  if (variables.length === 0) {
    const sample = data ? asNumber(data[GEOIQ_SAMPLE_VARIABLE]) : null;
    const seen = sample === null ? 'but the sample variable came back empty' : `sample ${GEOIQ_SAMPLE_VARIABLE} (total population) = ${sample}`;
    return {
      ...base,
      reachable: true,
      authorized: true,
      status,
      fieldsMissing: [],
      message: `The key works — GeoIQ answered at ${radius} m, ${seen}. No audience fields are mapped yet: map the catalogue variable ids to finish.`,
    };
  }
  const answered = variables.filter(([, id]) => data !== null && asNumber(data[id]) !== null).map(([field]) => field);
  const missing = fields.filter((field) => !answered.includes(field));
  const footfallId = variables.find(([field]) => field === 'footfall.daily')?.[1];
  const footfall = footfallId && data ? asNumber(data[footfallId]) : null;
  return {
    ...base,
    reachable: true,
    authorized: true,
    status,
    fieldsAnswered: answered,
    fieldsMissing: missing,
    sample: { footfallDaily: footfall === null ? null : Math.round(footfall) },
    message:
      missing.length === 0
        ? `GeoIQ answered every mapped field (${answered.length}) at ${radius} m.`
        : `GeoIQ answered ${answered.length} of ${fields.length} mapped fields at ${radius} m; ${missing.length} came back empty — check those variable ids against the account's catalogue.`,
  };
}
