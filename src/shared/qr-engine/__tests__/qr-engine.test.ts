import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The QR engine seam — QR-1.
 *
 * Pinned: LOCAL is the default and draws without touching the network; a
 * printed code under GENQR is drawn by GenQR and falls back to LOCAL when
 * GenQR does not answer, never failing; a hosted code's image falls back
 * to the STORED short URL, not to `/t/`; registering dynamic codes is 503
 * with no engine, batches at 500, zips answers in order, and refuses a
 * short answer; GenQR's error table maps as documented and the key never
 * appears in a message; analytics for a code GenQR cannot answer is absent,
 * not thrown; the probe reads the scopes and the redirect base and says
 * exactly what is missing.
 */

const { integrations } = vi.hoisted(() => ({
  integrations: { getEffectiveQrEngineConfig: vi.fn() },
}));

vi.mock('../../integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integrations')>();
  return { ...actual, ...integrations };
});

vi.mock('../../logging', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ApiError } from '../../errors';
import { GENQR_MAX_BATCH, dynamicCodeAnalytics, dynamicCodesAvailable, genqrError, qrEngineInForce, registerDynamicCodes, renderDynamic, renderPrinted, retireDynamicCode, testQrEngine } from '..';

const KEY = 'gqr_SECRET_KEY_DO_NOT_LEAK';

const localConfig = () => ({ provider: 'LOCAL' as const, style: {}, baseUrl: undefined, apiKey: undefined, shortBaseUrl: undefined });
const genqrConfig = (over: Record<string, unknown> = {}) => ({
  provider: 'GENQR' as const,
  baseUrl: 'https://genqr.example',
  apiKey: KEY,
  shortBaseUrl: 'https://go.adx.example',
  style: { foregroundColor: '#213333', dotStyle: 'rounded' as const },
  ...over,
});

type Answer = { status?: number; json?: unknown; bytes?: string; contentType?: string };

/** One fetch stub answering per path; anything unmatched is a 404. Records what was sent. */
function stubGenqr(answers: Record<string, Answer | ((init: RequestInit) => Answer)>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname + new URL(url).search;
    const found = Object.entries(answers).find(([key]) => path === key || path.startsWith(key));
    const answer = found ? (typeof found[1] === 'function' ? found[1](init) : found[1]) : { status: 404, json: { error: 'no' } };
    const status = answer.status ?? 200;
    const body = answer.bytes ?? '';
    return {
      ok: status < 400,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (answer.contentType ?? 'application/json') : null) },
      json: async () => answer.json ?? null,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

beforeEach(() => {
  integrations.getEffectiveQrEngineConfig.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LOCAL', () => {
  it('is the default and draws a PNG and an SVG without the network', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(localConfig());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await qrEngineInForce()).toBe('LOCAL');
    expect(await dynamicCodesAvailable()).toBe(false);

    const png = await renderPrinted({ content: 'https://adx.example/t/ABC23456', format: 'png', size: 200 });
    expect(png.engine).toBe('LOCAL');
    expect(png.styled).toBe(false);
    expect(png.contentType).toBe('image/png');
    // PNG magic bytes.
    expect(png.body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const svg = await renderPrinted({ content: 'hello', format: 'svg' });
    expect(svg.engine).toBe('LOCAL');
    expect(svg.body.toString('utf8')).toContain('<svg');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registering dynamic codes is 503 with no engine hosting them', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(localConfig());
    await expect(registerDynamicCodes([{ name: 'x', target: 'https://adx.example/t/X' }])).rejects.toMatchObject({
      statusCode: 503,
      code: 'INTEGRATION_NOT_CONFIGURED',
    });
  });

  it('the probe says codes are drawn locally', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(localConfig());
    const verdict = await testQrEngine();
    expect(verdict).toMatchObject({ engine: 'LOCAL', configured: true, reachable: true, authorized: true, account: null });
  });
});

describe('GENQR — drawing', () => {
  it('a printed code is drawn by GenQR with the stored style merged under the call', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    const { calls } = stubGenqr({ '/api/v1/render': { bytes: '<svg>styled</svg>', contentType: 'image/svg+xml' } });

    const out = await renderPrinted({ content: 'TOKEN', format: 'svg', style: { frameCaption: 'Scan to book' } });
    expect(out).toMatchObject({ engine: 'GENQR', format: 'svg', styled: true, contentType: 'image/svg+xml' });
    expect(out.body.toString('utf8')).toBe('<svg>styled</svg>');

    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toEqual({
      content: 'TOKEN',
      format: 'svg',
      style: { foregroundColor: '#213333', dotStyle: 'rounded', frameCaption: 'Scan to book' },
    });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("GenQR's PNG is honest: colours only", async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({ '/api/v1/render': { bytes: 'PNGBYTES', contentType: 'image/png' } });
    const out = await renderPrinted({ content: 'TOKEN', format: 'png', size: 400 });
    expect(out).toMatchObject({ engine: 'GENQR', format: 'png', styled: false, contentType: 'image/png' });
  });

  it('falls back to LOCAL when GenQR does not answer — a print job never fails to draw', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({ '/api/v1/render': { status: 500, json: { error: 'boom' } } });
    const out = await renderPrinted({ content: 'TOKEN', format: 'png' });
    expect(out.engine).toBe('LOCAL');
    expect(out.body.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('falls back to LOCAL when GenQR is chosen but has no key', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig({ apiKey: undefined }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await renderPrinted({ content: 'TOKEN', format: 'svg' });
    expect(out.engine).toBe('LOCAL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a hosted code's image is GenQR's; on failure the STORED short URL is drawn locally, never /t/", async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({ '/api/v1/qrcodes/g1/image.svg': { bytes: '<svg>g1</svg>', contentType: 'image/svg+xml' } });
    const ok = await renderDynamic({ engineCodeId: 'g1', shortUrl: 'https://go.adx.example/r/ABC' }, 'https://adx.example/t/ABC', 'svg');
    expect(ok.engine).toBe('GENQR');
    expect(ok.body.toString('utf8')).toBe('<svg>g1</svg>');

    stubGenqr({});
    const fallback = await renderDynamic({ engineCodeId: 'g1', shortUrl: 'https://go.adx.example/r/ABC' }, 'https://adx.example/t/ABC', 'svg');
    expect(fallback.engine).toBe('LOCAL');
    // The SVG's path data cannot be read back for the URL, so pin the decision
    // through the local renderer by comparing with a direct local draw.
    const { renderLocal } = await import('../local');
    const direct = await renderLocal({ content: 'https://go.adx.example/r/ABC', format: 'svg' });
    expect(fallback.body.equals(direct.body)).toBe(true);
    const asT = await renderLocal({ content: 'https://adx.example/t/ABC', format: 'svg' });
    expect(fallback.body.equals(asT.body)).toBe(false);
  });

  it('a code never registered with the engine is drawn as /t/ locally without a call', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    const { fetchMock } = stubGenqr({});
    const out = await renderDynamic({ engineCodeId: null, shortUrl: null }, 'https://adx.example/t/ABC', 'png');
    expect(out.engine).toBe('LOCAL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GENQR — dynamic codes', () => {
  const row = (i: number) => ({ id: `g${i}`, shortCode: `SC${i}`, shortUrl: `https://go.adx.example/r/SC${i}`, isDynamic: true });

  it('mints one code per request, in order, as dynamic url codes with the stored style', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    const { calls } = stubGenqr({
      '/api/v1/qrcodes/batch': (init) => {
        const items = JSON.parse(String(init.body)).items as { name: string }[];
        return { status: 201, json: { data: items.map((_, i) => row(i)), created: items.length } };
      },
    });
    const out = await registerDynamicCodes([
      { name: 'CMP-1 / spot A', target: 'https://adx.example/t/AAAA2345' },
      { name: 'CMP-1 / spot B', target: 'https://adx.example/t/BBBB2345' },
    ]);
    expect(out).toEqual([
      { engineCodeId: 'g0', shortCode: 'SC0', shortUrl: 'https://go.adx.example/r/SC0' },
      { engineCodeId: 'g1', shortCode: 'SC1', shortUrl: 'https://go.adx.example/r/SC1' },
    ]);
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.items[0]).toEqual({
      name: 'CMP-1 / spot A',
      type: 'url',
      content: 'https://adx.example/t/AAAA2345',
      isDynamic: true,
      style: { foregroundColor: '#213333', dotStyle: 'rounded' },
    });
  });

  it('batches at 500', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    const { calls } = stubGenqr({
      '/api/v1/qrcodes/batch': (init) => {
        const items = JSON.parse(String(init.body)).items as unknown[];
        return { status: 201, json: { data: items.map((_, i) => row(i)) } };
      },
    });
    const many = Array.from({ length: GENQR_MAX_BATCH + 7 }, (_, i) => ({ name: `n${i}`, target: `https://adx.example/t/${i}` }));
    const out = await registerDynamicCodes(many);
    expect(out).toHaveLength(GENQR_MAX_BATCH + 7);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]!.init.body)).items).toHaveLength(GENQR_MAX_BATCH);
    expect(JSON.parse(String(calls[1]!.init.body)).items).toHaveLength(7);
  });

  it('refuses a short answer rather than zipping the wrong rows', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({ '/api/v1/qrcodes/batch': { status: 201, json: { data: [row(0)] } } });
    await expect(
      registerDynamicCodes([
        { name: 'a', target: 'https://adx.example/t/A' },
        { name: 'b', target: 'https://adx.example/t/B' },
      ]),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('a quota refusal is 409, a missing scope 503 with the scope named, and the key is never in the message', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({ '/api/v1/qrcodes/batch': { status: 403, json: { error: 'Quota exceeded', code: 'quota_exceeded' } } });
    await expect(registerDynamicCodes([{ name: 'a', target: 'https://adx.example/t/A' }])).rejects.toMatchObject({ statusCode: 409 });

    stubGenqr({ '/api/v1/qrcodes/batch': { status: 403, json: { error: 'nope', code: 'insufficient_scope', required: 'qrcodes:write' } } });
    let caught: unknown;
    try {
      await registerDynamicCodes([{ name: 'a', target: 'https://adx.example/t/A' }]);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).statusCode).toBe(503);
    expect((caught as ApiError).message).toContain("'qrcodes:write'");
    expect((caught as ApiError).message).not.toContain(KEY);
  });

  it('retiring a code the engine no longer has is not an error', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({ '/api/v1/qrcodes/gone': { status: 404, json: { error: 'QR code not found' } } });
    await expect(retireDynamicCode('gone')).resolves.toBeUndefined();
    stubGenqr({ '/api/v1/qrcodes/there': { status: 200, json: { success: true } } });
    await expect(retireDynamicCode('there')).resolves.toBeUndefined();
  });

  it('analytics: a code GenQR cannot answer for is absent, the rest come back keyed by engine id', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({
      '/api/v1/qrcodes/g1/analytics': {
        json: {
          id: 'g1', days: 7, totalScans: 12, scansInWindow: 5,
          scansByDay: [{ date: '2026-09-16', count: 5 }],
          hourlyBreakdown: [], deviceBreakdown: [{ label: 'mobile', count: 5 }],
          browserBreakdown: [], osBreakdown: [], countryBreakdown: [{ label: 'India', code: 'IN', count: 5 }], cityBreakdown: [{ label: 'Bengaluru', count: 5 }],
        },
      },
      '/api/v1/qrcodes/g2/analytics': { status: 500, json: { error: 'boom' } },
    });
    const out = await dynamicCodeAnalytics(['g1', 'g2'], 7);
    expect(out.size).toBe(1);
    expect(out.get('g1')).toMatchObject({ engineCodeId: 'g1', totalScans: 12, scansInWindow: 5, cityBreakdown: [{ label: 'Bengaluru', count: 5 }] });
  });

  it('analytics asks nobody when the engine is LOCAL', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(localConfig());
    const { fetchMock } = stubGenqr({});
    expect((await dynamicCodeAnalytics(['g1'], 7)).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the error table', () => {
  it('maps as documented', () => {
    expect(genqrError(401, { error: 'Invalid or revoked API key.' })).toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(genqrError(403, { code: 'insufficient_scope', required: 'render' }).message).toContain("'render'");
    expect(genqrError(403, { code: 'quota_exceeded' })).toMatchObject({ statusCode: 409 });
    expect(genqrError(403, {})).toMatchObject({ statusCode: 503 });
    expect(genqrError(429, null)).toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS' });
    expect(genqrError(400, { error: 'Validation failed' })).toMatchObject({ statusCode: 400, message: 'Validation failed' });
    expect(genqrError(404, null)).toMatchObject({ statusCode: 404 });
    expect(genqrError(500, { error: 'x' })).toMatchObject({ statusCode: 502 });
  });
});

describe('the probe', () => {
  it('says what is missing before spending a call', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig({ apiKey: undefined }));
    const verdict = await testQrEngine();
    expect(verdict).toMatchObject({ engine: 'GENQR', configured: false, reachable: false, message: 'No GenQR API key is set.' });
  });

  it('reads the account, the scopes and the redirect base, and names every gap', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({
      '/api/v1/me': {
        json: { email: 'ops@adx.example', plan: { id: 'enterprise', name: 'Enterprise', apiAccessEnabled: true }, scope: 'qrcodes:read,qrcodes:write', redirectBase: 'https://genqr.example' },
      },
    });
    const verdict = await testQrEngine();
    expect(verdict).toMatchObject({
      engine: 'GENQR',
      configured: true,
      reachable: true,
      authorized: true,
      status: 200,
      account: { email: 'ops@adx.example', plan: 'Enterprise', apiAccess: true, scope: 'qrcodes:read,qrcodes:write', redirectBase: 'https://genqr.example' },
      scopesMissing: ['analytics:read', 'render'],
      shortBaseMatches: false,
    });
    expect(verdict.message).toContain('lacks analytics:read, render');
    expect(verdict.message).toContain('ADX expects https://go.adx.example');
    expect(verdict.message).not.toContain(KEY);
  });

  it('a wildcard key holds every scope and a matching base is a clean verdict', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({ '/api/v1/me': { json: { email: 'ops@adx.example', plan: { name: 'Enterprise', apiAccessEnabled: true }, scope: '*', redirectBase: 'https://go.adx.example/' } } });
    const verdict = await testQrEngine();
    expect(verdict.scopesMissing).toEqual([]);
    expect(verdict.shortBaseMatches).toBe(true);
    expect(verdict.message).toBe('GenQR answered as ops@adx.example on the Enterprise plan.');
  });

  it('a refused key is a verdict, not a throw', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    stubGenqr({ '/api/v1/me': { status: 401, json: { error: 'Invalid or revoked API key.' } } });
    const verdict = await testQrEngine();
    expect(verdict).toMatchObject({ reachable: true, authorized: false, status: 401 });
    expect(verdict.message).toContain('Invalid or revoked API key.');
  });

  it('an unreachable host is a verdict, not a throw', async () => {
    integrations.getEffectiveQrEngineConfig.mockResolvedValue(genqrConfig());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const verdict = await testQrEngine();
    expect(verdict).toMatchObject({ reachable: false, authorized: false });
    expect(verdict.message).toContain('ECONNREFUSED');
  });
});
