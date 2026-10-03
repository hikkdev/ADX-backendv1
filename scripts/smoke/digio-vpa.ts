/**
 * Digio's UPI ID (VPA) lookup — ONE live call, by hand, never by the suite
 * (the owner, 2 Oct 2026).
 *
 *   npm run smoke:digio-vpa -- --vpa=yourname@okhdfc
 *   npm run smoke:digio-vpa -- --vpa=yourname@okhdfc --name="Expected Name"
 *
 * For the owner to run on their OWN UPI ID once Digio confirms "VPA
 * Verification" is enabled on the account. It asks Digio's
 * `POST /v3/client/public/upi/check_vpa` with the keys in force (Settings ›
 * Integrations › KYC first, then the environment) and prints ONLY: the
 * status, Digio's status description, the fuzzy match score, the latency,
 * and the name Digio gave masked to the first letter of each word. Never a
 * key, never the UPI ID back, never a body. Nothing is written anywhere.
 *
 * It refuses to run without `--vpa=`.
 */
import '../../src/config/load-env';
import { redis } from '../../src/shared/cache';
import { closeDatabase } from '../../src/shared/database';
import { checkDigioVpa, digioConfigured, digioRequestId } from '../../src/shared/integrations/digio-client';
import { getEffectiveKycConfig } from '../../src/shared/integrations/integration-config';

const arg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length).trim();
};

/** "Asha Rao" → "A••• R••" — the first letter of each word, nothing else. */
function maskName(name: string | null): string {
  if (!name) return '(none)';
  return name
    .trim()
    .split(/\s+/)
    .map((word) => `${word.charAt(0)}${'•'.repeat(Math.max(0, word.length - 1))}`)
    .join(' ');
}

async function main(): Promise<number> {
  const vpa = arg('vpa');
  if (!vpa || !vpa.includes('@')) {
    console.log('Refused: name the UPI ID to look up, e.g. npm run smoke:digio-vpa -- --vpa=yourname@okhdfc [--name="Expected Name"]');
    return 2;
  }
  const name = arg('name') || undefined;
  const cfg = await getEffectiveKycConfig();
  if (!digioConfigured(cfg)) {
    console.log('Digio is not configured: set the client id and secret under Settings › Integrations › KYC (or DIGIO_CLIENT_ID / DIGIO_CLIENT_SECRET) and run again.');
    return 1;
  }
  let host = 'unknown host';
  try {
    host = new URL(cfg.baseUrl ?? '').host;
  } catch {
    /* the client falls back to the environment's base URL */
  }
  const stamp = `smoke${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  console.log(`Digio VPA lookup — one call to ${host}${name ? ', with an expected name' : ''}`);

  const started = Date.now();
  const outcome = await checkDigioVpa({ referenceId: digioRequestId(`adxsmoke${stamp}`), uniqueRequestId: digioRequestId(stamp), vpa, name }, { config: cfg });
  const latency = Date.now() - started;

  if (!outcome.ok) {
    const why = outcome.outage ?? (outcome.httpStatus === 401 || outcome.httpStatus === 403 ? 'AUTH_CONFIG (keys)' : outcome.httpStatus === 404 ? 'NOT_ENABLED (ask Digio to switch VPA Verification on)' : 'REFUSED');
    console.log(`  not answered: ${why}${outcome.httpStatus ? `  HTTP ${outcome.httpStatus}` : ''}${outcome.code ? `  code ${outcome.code}` : ''}`);
    console.log(`  latency            ${latency} ms`);
    return 1;
  }
  const answer = outcome.answer;
  console.log(`  status             ${answer.status || '(none)'}`);
  console.log(`  status_description ${answer.statusDescription ?? '(none)'}`);
  console.log(`  fuzzy_match_score  ${answer.fuzzyMatchScore ?? '(none)'}`);
  console.log(`  latency            ${latency} ms`);
  console.log(`  name at the bank   ${maskName(answer.customerName)}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error('smoke:digio-vpa failed:', err instanceof Error ? err.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch(() => undefined);
    redis.disconnect();
  });
