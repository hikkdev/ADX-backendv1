import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q129) — the Digio probe and the switch it moves.
 *
 * What is pinned: a failing probe flips DIGIO to DEGRADED and a passing one
 * flips it back; MANUAL is never touched; a switch already where the verdict
 * points is left alone; an unconfigured Digio is not a failure; the guard
 * answers 503 KYC_PROVIDER_UNAVAILABLE with a retryAfter for both off
 * states and lets DIGIO through.
 */

const { config } = vi.hoisted(() => ({
  config: { getEffectiveKycConfig: vi.fn(), updateIntegrationsConfig: vi.fn() },
}));

vi.mock('../../integrations/integration-config', () => ({
  ...config,
  KYC_PROVIDER_STATES: ['DIGIO', 'DEGRADED', 'MANUAL'],
}));

import { applyDigioProbe, probeDigio, runDigioProbe } from '../probe';
import { assertDigioAvailable, digioAvailabilityFrom } from '../../integrations/digio-client';

const live = { clientId: 'id', clientSecret: 'secret', baseUrl: 'https://digio.example', kycProvider: 'DIGIO' as const };
const fetchAnswering = (status: number) => vi.fn(async () => ({ status })) as unknown as typeof fetch;
const fetchDown = vi.fn(async () => {
  throw new Error('ECONNRESET');
}) as unknown as typeof fetch;

beforeEach(() => {
  vi.clearAllMocks();
  config.getEffectiveKycConfig.mockResolvedValue(live);
});

describe('probeDigio', () => {
  it('reads a 404 with accepted credentials as up, and auth or 5xx or a dead socket as down', async () => {
    expect(await probeDigio(live, fetchAnswering(404))).toMatchObject({ ok: true });
    expect(await probeDigio(live, fetchAnswering(401))).toMatchObject({ ok: false, detail: 'auth 401' });
    expect(await probeDigio(live, fetchAnswering(503))).toMatchObject({ ok: false, detail: 'status 503' });
    expect(await probeDigio(live, fetchDown)).toMatchObject({ ok: false, detail: 'ECONNRESET' });
  });

  it('treats an unconfigured Digio as fine: the mock path is a deployment, not an outage', async () => {
    const probe = vi.fn() as unknown as typeof fetch;
    expect(await probeDigio({ baseUrl: 'https://digio.example' }, probe)).toMatchObject({ ok: true });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('applyDigioProbe', () => {
  it('flips DIGIO to DEGRADED on failure and back on success', async () => {
    expect(await applyDigioProbe({ ok: false, latencyMs: 10 }, live)).toEqual({ from: 'DIGIO', to: 'DEGRADED' });
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('kyc', { kycProvider: 'DEGRADED' });

    expect(await applyDigioProbe({ ok: true, latencyMs: 10 }, { ...live, kycProvider: 'DEGRADED' })).toEqual({ from: 'DEGRADED', to: 'DIGIO' });
    expect(config.updateIntegrationsConfig).toHaveBeenLastCalledWith('kyc', { kycProvider: 'DIGIO' });
  });

  it('leaves a switch alone when the verdict agrees with it, and never touches MANUAL', async () => {
    expect(await applyDigioProbe({ ok: true, latencyMs: 10 }, live)).toBeNull();
    expect(await applyDigioProbe({ ok: false, latencyMs: 10 }, { ...live, kycProvider: 'DEGRADED' })).toBeNull();
    expect(await applyDigioProbe({ ok: false, latencyMs: 10 }, { ...live, kycProvider: 'MANUAL' })).toBeNull();
    expect(await applyDigioProbe({ ok: true, latencyMs: 10 }, { ...live, kycProvider: 'MANUAL' })).toBeNull();
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });

  it('runs as one tick: probe, apply, report', async () => {
    const result = await runDigioProbe(fetchDown);
    expect(result.verdict.ok).toBe(false);
    expect(result.change).toEqual({ from: 'DIGIO', to: 'DEGRADED' });
  });
});

describe('the guard every initiate and restart passes through', () => {
  it('lets DIGIO through and refuses the two off states with a retryAfter', () => {
    expect(() => assertDigioAvailable(live)).not.toThrow();
    expect(digioAvailabilityFrom({})).toEqual({ available: true, provider: 'DIGIO', retryAfter: null });

    expect(() => assertDigioAvailable({ ...live, kycProvider: 'DEGRADED' })).toThrow(
      expect.objectContaining({ statusCode: 503, code: 'KYC_PROVIDER_UNAVAILABLE', details: { provider: 'DEGRADED', retryAfter: 300 } }),
    );
    expect(() => assertDigioAvailable({ ...live, kycProvider: 'MANUAL' })).toThrow(
      expect.objectContaining({ statusCode: 503, code: 'KYC_PROVIDER_UNAVAILABLE', details: { provider: 'MANUAL', retryAfter: 3600 } }),
    );
  });
});
