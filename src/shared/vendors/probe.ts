import { logger } from '../logging/logger';
import {
  digioConfigured,
  getEffectiveKycConfig,
  updateIntegrationsConfig,
  type KycConfig,
  type KycProviderState,
} from '../integrations';

/**
 * Vendor probes — Lot D (Q129).
 *
 * A vendor that stops answering should take itself off the menu before a
 * publisher finds out by tapping the button. The probe is a small
 * authenticated request against the vendor; its verdict moves the provider
 * switch in the integrations row — DIGIO → DEGRADED on failure, back on
 * success — and never touches MANUAL, which is ops saying "off, whatever the
 * probe thinks". The job in `src/jobs/kyc-provider-probe.job.ts` runs it on
 * a five-minute Redis-locked tick and tells the admins when it moves.
 *
 * Unconfigured Digio is not a failure: the mock path is what a deployment
 * without credentials runs on, and degrading it would take that away.
 */

export type ProbeVerdict = { ok: boolean; latencyMs: number; detail?: string };

const PROBE_TIMEOUT_MS = 8_000;

export async function probeDigio(cfg?: KycConfig, fetchImpl: typeof fetch = fetch): Promise<ProbeVerdict> {
  const config = cfg ?? (await getEffectiveKycConfig());
  if (!digioConfigured(config)) return { ok: true, latencyMs: 0, detail: 'unconfigured; mock path' };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // An authenticated read of a request that does not exist: 404 proves the
    // host is up and the credentials are accepted; 401/403 or 5xx do not.
    const response = await fetchImpl(`${config.baseUrl}/client/kyc/v2/probe-${Date.now()}`, {
      method: 'GET',
      headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}` },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (response.status === 401 || response.status === 403) return { ok: false, latencyMs, detail: `auth ${response.status}` };
    if (response.status >= 500) return { ok: false, latencyMs, detail: `status ${response.status}` };
    return { ok: true, latencyMs, detail: `status ${response.status}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export type ProviderChange = { from: KycProviderState; to: KycProviderState } | null;

/**
 * Applies a verdict to the switch. Returns the move it made, or null when
 * nothing changed — including every time the switch is MANUAL.
 */
export async function applyDigioProbe(verdict: ProbeVerdict, cfg?: KycConfig): Promise<ProviderChange> {
  const config = cfg ?? (await getEffectiveKycConfig());
  const current = config.kycProvider ?? 'DIGIO';
  if (current === 'MANUAL') return null;

  const next: KycProviderState = verdict.ok ? 'DIGIO' : 'DEGRADED';
  if (next === current) return null;

  await updateIntegrationsConfig('kyc', { kycProvider: next });
  logger.warn('KYC provider switch moved by the probe', { from: current, to: next, detail: verdict.detail, latencyMs: verdict.latencyMs });
  return { from: current, to: next };
}

/** One tick: probe, apply, report. */
export async function runDigioProbe(fetchImpl: typeof fetch = fetch): Promise<{ verdict: ProbeVerdict; change: ProviderChange }> {
  const cfg = await getEffectiveKycConfig();
  const verdict = await probeDigio(cfg, fetchImpl);
  const change = await applyDigioProbe(verdict, cfg);
  return { verdict, change };
}
