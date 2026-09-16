import { ApiError } from '../errors';
import { getEffectiveAudienceConfig } from '../integrations';
import { logger } from '../logging';
import { periodBounds, type AudienceCatchment, type AudienceProvider, type AudienceShare, type AudienceVendorTest } from './types';

/**
 * Azira (formerly Near), behind the audience seam — G7 (Q109).
 *
 * Azira's footfall and visitor-insight product answers a geofence and a date
 * range with visitation (a daily average, an hour-of-day and a day-of-week
 * profile) and the visitors' demographics (age, gender, income bands and
 * affinity segments) — the four panels the Audience Breakdown draws.
 *
 * The request the adapter sends and the answer it reads are the shape in
 * `__tests__/fixtures/azira-catchment.json`:
 *
 *   POST {aziraBaseUrl}/insights/footfall
 *     Authorization: Bearer <apiKey>    X-Client-Id: <clientId>
 *     { "location": { "lat", "lng", "radius_m" }, "period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } }
 *   → { "footfall": { "daily_average", "hourly": [24], "weekday": [7] },
 *       "demographics": { "age": { band: share }, "gender": { label: share },
 *                         "income": { band: share }, "affinities": [{ "name", "share" }] } }
 *
 * Azira publishes no open API reference — the endpoint and field names are
 * confirmed against the account's API documentation when the contract and
 * credentials arrive, which is also when `aziraBaseUrl` is set; until then
 * there is no default host and the adapter answers 503. Every field it
 * cannot find in the answer is null, never invented; a panel of the wrong
 * length (23 hours) is null rather than padded.
 */

type AziraResponse = {
  footfall?: { daily_average?: number; hourly?: unknown; weekday?: unknown };
  demographics?: {
    age?: Record<string, unknown>;
    gender?: Record<string, unknown>;
    income?: Record<string, unknown>;
    affinities?: { name?: string; share?: unknown }[] | Record<string, unknown>;
  };
  message?: string;
  error?: string;
};

type AziraCredentials = { key: string; baseUrl: string; clientId: string | undefined };

const NOT_CONFIGURED = 'Azira is not configured: the API key and the API base URL are both needed.';

async function requireConfig(): Promise<AziraCredentials> {
  const cfg = await getEffectiveAudienceConfig();
  const key = cfg.aziraApiKey?.trim();
  const baseUrl = cfg.aziraBaseUrl?.trim();
  if (!key || !baseUrl) {
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', NOT_CONFIGURED);
  }
  return { key, baseUrl, clientId: cfg.aziraClientId?.trim() };
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** A share as the vendor gives it — a fraction becomes percent; percent stays. */
const asShare = (value: unknown, fractional: boolean): number | null => {
  const n = asNumber(value);
  return n === null ? null : Math.round(n * (fractional ? 100 : 1) * 10) / 10;
};

/** A profile of exactly `length` numbers, or null. Fractions become percent. */
export function profileOf(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  const numbers = value.map(asNumber);
  if (numbers.some((n) => n === null)) return null;
  const sum = (numbers as number[]).reduce((a, b) => a + b, 0);
  const scale = sum > 0 && sum <= 1.001 ? 100 : 1;
  return (numbers as number[]).map((n) => Math.round(n * scale * 10) / 10);
}

/** `{ "18-24": 0.21, ... }` → shares, or null when nothing numeric is there. */
export function sharesOf(record: Record<string, unknown> | undefined): AudienceShare[] | null {
  if (!record || typeof record !== 'object') return null;
  const entries = Object.entries(record).filter(([, v]) => asNumber(v) !== null) as [string, number][];
  if (entries.length === 0) return null;
  const sum = entries.reduce((acc, [, v]) => acc + v, 0);
  const fractional = sum > 0 && sum <= 1.001;
  return entries.map(([label, v]) => ({ label, share: asShare(v, fractional)! }));
}

function affinitiesOf(value: { name?: string; share?: unknown }[] | Record<string, unknown> | undefined): AudienceShare[] | null {
  if (Array.isArray(value)) {
    const named = value.filter((a) => typeof a.name === 'string' && asNumber(a.share) !== null) as { name: string; share: number }[];
    if (named.length === 0) return null;
    const sum = named.reduce((acc, a) => acc + a.share, 0);
    const fractional = sum > 0 && sum <= 1.001;
    return named.map((a) => ({ label: a.name, share: asShare(a.share, fractional)! }));
  }
  return sharesOf(value as Record<string, unknown> | undefined);
}

const day = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * One call: the circle and the month, the bearer key and the client id.
 * Throws 502 when the host cannot be reached (the message names the
 * failure, never the key); every other outcome is returned for the caller
 * to judge, so the vendor test can print a refusal instead of throwing it.
 */
async function callAzira(creds: AziraCredentials, lat: number, lng: number, radiusM: number, period: string): Promise<{ status: number; body: AziraResponse }> {
  const { start, end } = periodBounds(period);
  const lastDay = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  let response: Response;
  try {
    response = await fetch(`${creds.baseUrl}/insights/footfall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.key}`,
        ...(creds.clientId ? { 'X-Client-Id': creds.clientId } : {}),
      },
      body: JSON.stringify({
        location: { lat, lng, radius_m: radiusM },
        period: { start: day(start), end: day(lastDay) },
      }),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    logger.error('Azira unreachable', { reason });
    throw new ApiError(502, 'INTERNAL_ERROR', `Azira could not be reached: ${reason}`);
  }
  const body = (await response.json().catch(() => ({}))) as AziraResponse;
  return { status: response.status, body };
}

/** The error table over the status. Throws for everything but a 2xx and a 404 (nothing for the circle). */
function throwForAziraStatus(status: number, body: AziraResponse): void {
  if (status >= 200 && status < 300) return;
  if (status === 404) return;
  const message = body.message ?? body.error;
  if (status === 401 || status === 403) {
    logger.error('Azira refused the key', { message });
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Azira refused the request. Check the API key and client id.');
  }
  if (status === 429) throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Azira rate limit reached. Try again shortly.');
  if (status === 400 || status === 422) throw new ApiError(400, 'BAD_REQUEST', message ?? 'Azira rejected the request.');
  logger.error('Azira unexpected status', { http: status, message });
  throw new ApiError(502, 'INTERNAL_ERROR', `Azira answered HTTP ${status}.`);
}

/** The recorded shape read into the seam's footfall and demographics; what is not there is null. */
function readAzira(body: AziraResponse): Pick<AudienceCatchment, 'footfall' | 'demographics'> {
  const daily = asNumber(body.footfall?.daily_average);
  return {
    footfall: {
      daily: daily === null ? null : Math.round(daily),
      byHour: profileOf(body.footfall?.hourly, 24),
      byWeekday: profileOf(body.footfall?.weekday, 7),
    },
    demographics: {
      ageBands: sharesOf(body.demographics?.age),
      gender: sharesOf(body.demographics?.gender),
      incomeBands: sharesOf(body.demographics?.income),
      affinities: affinitiesOf(body.demographics?.affinities),
    },
  };
}

export async function aziraCatchment(lat: number, lng: number, radiusM: number, period: string): Promise<AudienceCatchment | null> {
  const creds = await requireConfig();
  const { status, body } = await callAzira(creds, lat, lng, radiusM, period);
  throwForAziraStatus(status, body);
  if (status === 404) return null;

  const { footfall, demographics } = readAzira(body);
  const anything =
    footfall.daily !== null || footfall.byHour !== null || footfall.byWeekday !== null || Object.values(demographics).some((g) => g !== null);
  if (!anything) return null;

  return { footfall, demographics, provenance: 'PANEL', vendor: 'AZIRA', period, radiusM, fetchedAt: new Date().toISOString() };
}

/** The seam's groups an Azira answer can carry — what the vendor test names as answered / missing. */
const AZIRA_GROUPS = ['footfall.daily', 'footfall.byHour', 'footfall.byWeekday', 'age', 'gender', 'income', 'affinity'] as const;

/**
 * AC-B2: the vendor test behind the card, through this adapter. Asks Azira
 * ONCE about `point` for the current month at the row's radius and answers
 * a verdict; no configuration is a graceful verdict (reachable false, the
 * sentence saying what is missing), never a 503. `variablesMapped` is 0 —
 * Azira has no variable map; its answer is one shape.
 */
export async function aziraTest(point: { lat: number; lng: number }): Promise<AudienceVendorTest> {
  const cfg = await getEffectiveAudienceConfig();
  const key = cfg.aziraApiKey?.trim();
  const baseUrl = cfg.aziraBaseUrl?.trim();
  const base: AudienceVendorTest = {
    vendor: 'AZIRA',
    keyPresent: Boolean(key),
    variablesMapped: 0,
    reachable: false,
    authorized: false,
    status: null,
    message: '',
    fieldsAnswered: [],
    fieldsMissing: [...AZIRA_GROUPS],
    sample: { footfallDaily: null },
  };
  if (!key || !baseUrl) {
    const missing = [!key ? 'the API key' : null, !baseUrl ? 'the API base URL (from the contract; there is no public default)' : null].filter(Boolean).join(' and ');
    return { ...base, message: `${NOT_CONFIGURED} Missing: ${missing}.` };
  }
  const period = new Date().toISOString().slice(0, 7);
  let status: number;
  let body: AziraResponse;
  try {
    ({ status, body } = await callAzira({ key, baseUrl, clientId: cfg.aziraClientId?.trim() }, point.lat, point.lng, cfg.catchmentRadiusM, period));
  } catch (err) {
    const reason = err instanceof ApiError ? err.message : 'Azira could not be reached.';
    return { ...base, message: `${reason} Check the base URL (${baseUrl}) and the network.` };
  }
  const said = body.message ?? body.error;
  const quoting = said ? ` Azira said: "${said}"` : '';
  if (status === 401 || status === 403) {
    return { ...base, reachable: true, status, message: `Azira refused the key. Check the API key and client id.${quoting}` };
  }
  if (status < 200 || status >= 300) {
    const what = status === 429 ? 'Azira rate limit reached; try again shortly.' : status === 404 ? 'Azira had nothing for the test circle.' : `Azira answered HTTP ${status}.`;
    return { ...base, reachable: true, authorized: true, status, message: `${what}${quoting}` };
  }
  const { footfall, demographics } = readAzira(body);
  const present: Record<(typeof AZIRA_GROUPS)[number], boolean> = {
    'footfall.daily': footfall.daily !== null,
    'footfall.byHour': footfall.byHour !== null,
    'footfall.byWeekday': footfall.byWeekday !== null,
    age: demographics.ageBands !== null,
    gender: demographics.gender !== null,
    income: demographics.incomeBands !== null,
    affinity: demographics.affinities !== null,
  };
  const answered = AZIRA_GROUPS.filter((g) => present[g]);
  const missing = AZIRA_GROUPS.filter((g) => !present[g]);
  return {
    ...base,
    reachable: true,
    authorized: true,
    status,
    fieldsAnswered: [...answered],
    fieldsMissing: [...missing],
    sample: { footfallDaily: footfall.daily },
    message:
      answered.length === 0
        ? `Azira answered, but the answer carried none of the seam's groups for ${period} at ${cfg.catchmentRadiusM} m.`
        : `Azira answered ${answered.length} of ${AZIRA_GROUPS.length} groups for ${period} at ${cfg.catchmentRadiusM} m.`,
  };
}

export const aziraAudienceProvider: AudienceProvider = { name: 'AZIRA', catchment: aziraCatchment };
