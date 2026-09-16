import { ApiError } from '../errors';
import { getEffectiveQrEngineConfig, type QrEngineStyle } from '../integrations';
import { logger } from '../logging';
import type { DynamicCode, DynamicCodeAnalytics, DynamicCodeRequest, QrEngineTest, QrRenderRequest, QrRenderResult } from './types';

/**
 * GenQR, behind the QR engine seam — QR-1.
 *
 * GenQR is our own QR platform: its own repository, deployment and
 * database, sold to the public as a service. ADX is a tenant of it — an
 * Enterprise account with a scoped key — and reaches it the way any
 * customer does, over `/api/v1`:
 *
 *   Authorization: Bearer gqr_…
 *   POST /api/v1/qrcodes/batch      { items: [{ name, content, isDynamic }] }   ≤ 500 a call, atomic
 *   GET  /api/v1/qrcodes/:id/analytics?days=
 *   GET  /api/v1/qrcodes/:id/image.(svg|png)
 *   POST /api/v1/render             { content, style, format, size }          nothing stored
 *   GET  /api/v1/me                 the account, its plan, the key's scope, the redirect base
 *
 * Every code GenQR returns carries `shortUrl` — the account's redirect base
 * plus `/r/<shortCode>`. The base is set on the GenQR account to the
 * ADX-branded short origin, and ADX's edge proxies that origin's `/r/` to
 * GenQR, so a hoarding never names GenQR.
 *
 * Errors, by GenQR's own table: 401 is a bad or revoked key and 403 with
 * `insufficient_scope` a key missing a scope — both 503
 * `INTEGRATION_NOT_CONFIGURED`, carrying GenQR's sentence so ops read what
 * it said; 403 `quota_exceeded` is 409; 429 is 429; anything else 502.
 * Unreachable is 502. The key goes in the header and nowhere else — never
 * in a log line, an error message or a verdict.
 */

export const GENQR_MAX_BATCH = 500;
/** The scopes the whole integration needs, for the verdict's `scopesMissing`. */
export const GENQR_REQUIRED_SCOPES = ['qrcodes:read', 'qrcodes:write', 'analytics:read', 'render'] as const;
const TIMEOUT_MS = 15_000;

export type GenqrCredentials = { baseUrl: string; apiKey: string; shortBaseUrl: string | undefined; style: QrEngineStyle };

export async function genqrCredentials(): Promise<GenqrCredentials> {
  const cfg = await getEffectiveQrEngineConfig();
  if (!cfg.baseUrl) {
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'GenQR is not configured: no base URL is set.');
  }
  if (!cfg.apiKey) {
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'GenQR is not configured: no API key is set.');
  }
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, shortBaseUrl: cfg.shortBaseUrl, style: cfg.style };
}

type GenqrFailure = { error?: string; code?: string; required?: string };

const quoting = (message: string | undefined) => (message ? ` GenQR said: "${message}"` : '');

/** GenQR's answer on a non-2xx, by its own table. Never throws for a 2xx. */
export function genqrError(status: number, body: GenqrFailure | null): ApiError {
  const message = body?.error;
  if (status === 401) {
    return new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', `GenQR refused the key: invalid, revoked or expired.${quoting(message)}`);
  }
  if (status === 403 && body?.code === 'insufficient_scope') {
    return new ApiError(
      503,
      'INTEGRATION_NOT_CONFIGURED',
      `GenQR key lacks the '${body.required ?? '?'}' scope — add it to the key on GenQR.${quoting(message)}`,
    );
  }
  if (status === 403 && body?.code === 'quota_exceeded') {
    return new ApiError(409, 'CONFLICT', `GenQR quota reached.${quoting(message)}`);
  }
  if (status === 403) return new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', `GenQR refused the request.${quoting(message)}`);
  if (status === 429) return new ApiError(429, 'TOO_MANY_REQUESTS', 'GenQR rate limit reached. Try again shortly.');
  if (status === 400 || status === 422) return new ApiError(400, 'BAD_REQUEST', message ?? 'GenQR rejected the request.');
  if (status === 404) return new ApiError(404, 'NOT_FOUND', message ?? 'GenQR has no such code.');
  return new ApiError(502, 'INTERNAL_ERROR', `GenQR answered ${status}.${quoting(message)}`);
}

/**
 * One call. Throws 502 when the host cannot be reached (the message names
 * the failure, never the key); a non-2xx is thrown by the error table. The
 * body comes back as JSON or as bytes, whichever the caller asked for.
 */
export async function callGenqr(
  creds: Pick<GenqrCredentials, 'baseUrl' | 'apiKey'>,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  accept: 'json' | 'bytes' = 'json',
): Promise<{ status: number; json: unknown; bytes: Buffer | null; contentType: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${creds.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        Accept: accept === 'json' ? 'application/json' : '*/*',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    logger.error('GenQR unreachable', { reason, path });
    throw new ApiError(502, 'INTERNAL_ERROR', `GenQR could not be reached: ${reason}`);
  }
  const contentType = response.headers.get('content-type');
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as GenqrFailure | null;
    throw genqrError(response.status, failure);
  }
  if (accept === 'bytes') {
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, json: null, bytes, contentType };
  }
  const json = await response.json().catch(() => null);
  return { status: response.status, json, bytes: null, contentType };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** A styled image of content ADX owns. GenQR stores nothing and spends no quota. */
export async function renderGenqr(request: QrRenderRequest): Promise<QrRenderResult> {
  const creds = await genqrCredentials();
  const style = { ...creds.style, ...(request.style ?? {}) };
  const answer = await callGenqr(
    creds,
    'POST',
    '/api/v1/render',
    { content: request.content, style, format: request.format, ...(request.size ? { size: request.size } : {}) },
    'bytes',
  );
  return {
    engine: 'GENQR',
    format: request.format,
    contentType: request.format === 'svg' ? 'image/svg+xml' : 'image/png',
    body: answer.bytes ?? Buffer.alloc(0),
    // GenQR's SVG carries the whole style; its PNG is colours and size only.
    styled: request.format === 'svg',
  };
}

/** The image of a dynamic code GenQR hosts — encodes the account's redirect base. */
export async function genqrCodeImage(engineCodeId: string, format: 'svg' | 'png', size?: number): Promise<QrRenderResult> {
  const creds = await genqrCredentials();
  const query = size ? `?size=${encodeURIComponent(String(size))}` : '';
  const answer = await callGenqr(creds, 'GET', `/api/v1/qrcodes/${encodeURIComponent(engineCodeId)}/image.${format}${query}`, undefined, 'bytes');
  return {
    engine: 'GENQR',
    format,
    contentType: format === 'svg' ? 'image/svg+xml' : 'image/png',
    body: answer.bytes ?? Buffer.alloc(0),
    styled: format === 'svg',
  };
}

/* ------------------------------------------------------------------ */
/* Dynamic codes                                                       */
/* ------------------------------------------------------------------ */

type GenqrCodeRow = { id: string; shortCode: string | null; shortUrl: string | null; isDynamic: boolean };

function toDynamicCode(row: GenqrCodeRow): DynamicCode {
  if (!row.shortCode || !row.shortUrl) {
    throw new ApiError(502, 'INTERNAL_ERROR', 'GenQR returned a dynamic code without a short URL.');
  }
  return { engineCodeId: row.id, shortCode: row.shortCode, shortUrl: row.shortUrl };
}

/**
 * Mints one dynamic code per request, in batches of at most 500 — each batch
 * atomic on GenQR's side. The order of the answer is the order asked, so the
 * caller can zip them back onto its own rows.
 */
export async function registerGenqrDynamic(items: readonly DynamicCodeRequest[]): Promise<DynamicCode[]> {
  if (items.length === 0) return [];
  const creds = await genqrCredentials();
  const out: DynamicCode[] = [];
  for (let start = 0; start < items.length; start += GENQR_MAX_BATCH) {
    const chunk = items.slice(start, start + GENQR_MAX_BATCH);
    const answer = await callGenqr(creds, 'POST', '/api/v1/qrcodes/batch', {
      items: chunk.map((item) => ({ name: item.name, type: 'url', content: item.target, isDynamic: true, style: creds.style })),
    });
    const rows = ((answer.json as { data?: GenqrCodeRow[] } | null)?.data ?? []) as GenqrCodeRow[];
    if (rows.length !== chunk.length) {
      throw new ApiError(502, 'INTERNAL_ERROR', `GenQR created ${rows.length} of ${chunk.length} codes in a batch.`);
    }
    for (const row of rows) out.push(toDynamicCode(row));
  }
  return out;
}

export async function deleteGenqrCode(engineCodeId: string): Promise<void> {
  const creds = await genqrCredentials();
  await callGenqr(creds, 'DELETE', `/api/v1/qrcodes/${encodeURIComponent(engineCodeId)}`);
}

type GenqrAnalyticsAnswer = Omit<DynamicCodeAnalytics, 'engineCodeId'> & { id: string };

export async function genqrCodeAnalytics(engineCodeId: string, days: number): Promise<DynamicCodeAnalytics> {
  const creds = await genqrCredentials();
  const answer = await callGenqr(creds, 'GET', `/api/v1/qrcodes/${encodeURIComponent(engineCodeId)}/analytics?days=${encodeURIComponent(String(days))}`);
  const body = answer.json as GenqrAnalyticsAnswer | null;
  if (!body || typeof body !== 'object') throw new ApiError(502, 'INTERNAL_ERROR', 'GenQR answered analytics with no body.');
  return {
    engineCodeId,
    days: body.days ?? days,
    totalScans: body.totalScans ?? 0,
    scansInWindow: body.scansInWindow ?? 0,
    scansByDay: body.scansByDay ?? [],
    hourlyBreakdown: body.hourlyBreakdown ?? [],
    deviceBreakdown: body.deviceBreakdown ?? [],
    browserBreakdown: body.browserBreakdown ?? [],
    osBreakdown: body.osBreakdown ?? [],
    countryBreakdown: body.countryBreakdown ?? [],
    cityBreakdown: body.cityBreakdown ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* The probe                                                           */
/* ------------------------------------------------------------------ */

type GenqrMe = {
  email?: string;
  plan?: { id?: string; name?: string; apiAccessEnabled?: boolean };
  scope?: string;
  redirectBase?: string;
};

/**
 * The card's test: one `GET /api/v1/me` on the stored key. A verdict, not a
 * throw, for anything GenQR did — the card prints it. Spends nothing.
 */
export async function genqrTest(): Promise<QrEngineTest> {
  const cfg = await getEffectiveQrEngineConfig();
  const base: QrEngineTest = {
    engine: 'GENQR',
    configured: Boolean(cfg.baseUrl && cfg.apiKey),
    reachable: false,
    authorized: false,
    status: null,
    message: '',
    account: null,
    scopesMissing: [],
    shortBaseMatches: null,
  };
  if (!cfg.baseUrl) return { ...base, message: 'No GenQR base URL is set.' };
  if (!cfg.apiKey) return { ...base, message: 'No GenQR API key is set.' };

  let response: Response;
  try {
    response = await fetch(`${cfg.baseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ...base, message: `GenQR could not be reached: ${reason}` };
  }
  const body = (await response.json().catch(() => null)) as (GenqrMe & GenqrFailure) | null;
  if (!response.ok) {
    const failure = genqrError(response.status, body);
    return { ...base, reachable: true, status: response.status, message: failure.message };
  }
  const scope = body?.scope ?? '*';
  const held = scope === '*' ? new Set(GENQR_REQUIRED_SCOPES as readonly string[]) : new Set(scope.split(',').map((s) => s.trim()));
  const scopesMissing = scope === 'none' ? [...GENQR_REQUIRED_SCOPES] : GENQR_REQUIRED_SCOPES.filter((s) => !held.has(s));
  const redirectBase = (body?.redirectBase ?? '').replace(/\/+$/, '');
  const shortBaseMatches = cfg.shortBaseUrl ? redirectBase === cfg.shortBaseUrl : null;
  const apiAccess = body?.plan?.apiAccessEnabled === true;
  const notes: string[] = [];
  if (!apiAccess) notes.push('the plan has no API access');
  if (scopesMissing.length > 0) notes.push(`the key lacks ${scopesMissing.join(', ')}`);
  if (shortBaseMatches === false) notes.push(`GenQR prints ${redirectBase || 'its own host'} but ADX expects ${cfg.shortBaseUrl}`);
  return {
    ...base,
    reachable: true,
    authorized: true,
    status: response.status,
    message: notes.length === 0 ? `GenQR answered as ${body?.email ?? 'the account'} on the ${body?.plan?.name ?? '?'} plan.` : `GenQR answered, but ${notes.join('; ')}.`,
    account: {
      email: body?.email ?? '',
      plan: body?.plan?.name ?? body?.plan?.id ?? '',
      apiAccess,
      scope,
      redirectBase,
    },
    scopesMissing,
    shortBaseMatches,
  };
}
