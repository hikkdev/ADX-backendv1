/**
 * Cashfree Phase 1 — the Secure ID smoke run (by hand, never by the suite).
 *
 *   npm run smoke:secure-id                 # every check, one call each, against the SANDBOX
 *   npm run smoke:secure-id -- --only=PAN   # one check
 *   npm run smoke:secure-id -- --live       # against the LIVE host (spends real money; off by default)
 *
 * One call per check with the test values Cashfree documents for its
 * sandbox ("Validations using any data other than what's listed in this
 * topic will fail"), through the real provider with the keys in force —
 * the settings row first, then the environment. It prints STATUSES ONLY:
 * the check, VERIFIED / FAILED / PENDING / NEEDS_USER_ACTION, the error
 * class and Cashfree's code when it failed, the latency. Never a name, a
 * number, a key or a body.
 *
 * DigiLocker cannot be smoked: Cashfree's sandbox wants a real Aadhaar and a
 * person at the page. The run asks for the page (CREATE) and prints whether
 * one came back — that proves the account has DigiLocker activated (a 404
 * is NOT_ENABLED). The face checks send a one-pixel PNG, which the sandbox
 * accepts as "a valid image". Nothing is written to the database: the run
 * uses the memory stores.
 */
import '../../src/config/load-env';
import { redis } from '../../src/shared/cache';
import { closeDatabase } from '../../src/shared/database';
import { getEffectiveSecureIdConfig } from '../../src/shared/integrations';
import { CHECK_TYPES, cashfreeSecureIdProvider, resolveVerificationSettings, secureIdConfigured, type CheckInputs, type CheckResult, type CheckType } from '../../src/shared/verification';

/** A 1×1 transparent PNG. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const image = { bytes: PIXEL, mime: 'image/png' as const, filename: 'pixel.png' };

/** Cashfree's documented sandbox values (the reference of 1 Oct 2026, §2.6, §3.5, §5, §6.3, §9, §12). */
const INPUTS: { [C in CheckType]?: CheckInputs[C] } = {
  PAN: { pan: 'ABCPV1234D', name: 'JOHN DOE' },
  BANK_ACCOUNT: { accountNumber: '026291800001191', ifsc: 'YESB0000262', name: 'JOHN DOE', mode: 'SYNC' },
  GSTIN: { gstin: '29AAICP2912R1ZR' },
  VEHICLE_RC: { vehicleNumber: 'HJ01ME5678' },
  DRIVING_LICENCE: { dlNumber: 'KA0120198900984', dob: '1994-08-05' },
  FACE_LIVENESS: { image },
  FACE_MATCH: { first: image, second: image },
  NAME_MATCH: { name1: 'JOHN DOE', name2: 'JOHN DE' },
  DIGILOCKER: { documents: ['AADHAAR', 'PAN'], redirectUrl: 'https://adx.in/verify/back' },
  UPI_VPA: { vpa: 'success@upi', name: 'JOHN DOE', consent: { obtainedAt: new Date(), purpose: 'Smoke run of the UPI penny drop on the sandbox' } },
};

const ORDER: CheckType[] = ['PAN', 'BANK_ACCOUNT', 'GSTIN', 'VEHICLE_RC', 'DRIVING_LICENCE', 'FACE_LIVENESS', 'FACE_MATCH', 'NAME_MATCH', 'DIGILOCKER', 'UPI_VPA'];

function line(check: CheckType, result: CheckResult, ms: number): string {
  const verdict = result.status === 'FAILED' ? `FAILED (${result.errorClass}${result.failureCode ? ` ${result.failureCode}` : ''})` : result.status;
  return `  ${check.padEnd(16)} ${verdict.padEnd(44)} ${String(ms).padStart(5)} ms${result.nameMatchScore !== undefined ? `  name match ${result.nameMatchScore}` : ''}`;
}

async function main(): Promise<number> {
  const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).toUpperCase();
  const live = process.argv.includes('--live');
  const keys = await getEffectiveSecureIdConfig();
  if (!secureIdConfigured(keys)) {
    console.log('Cashfree Secure ID is not configured: set CASHFREE_VERIFICATION_CLIENT_ID / _SECRET (or Settings › Integrations › Secure ID) and run again.');
    return 1;
  }
  const testMode = live ? false : true;
  console.log(`Cashfree Secure ID smoke — ${testMode ? 'SANDBOX' : 'LIVE'} host, signing: ${keys.publicKey ? 'public key (x-cf-signature)' : 'none (IP whitelist)'}`);
  const settings = resolveVerificationSettings({ upiCheck: 'PENNY_DROP' });
  const provider = cashfreeSecureIdProvider;
  const checks = only ? ORDER.filter((check) => check === only) : ORDER;
  if (checks.length === 0) {
    console.log(`Unknown check ${only}. One of: ${CHECK_TYPES.join(', ')}`);
    return 2;
  }
  let failures = 0;
  for (const check of checks) {
    const input = INPUTS[check];
    if (!input) continue;
    const verificationId = `smoke${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    const result = await provider.run(check, input as never, { verificationId, attemptNo: 1, caseType: 'LISTING', caseId: 'smoke', settings, now: () => new Date() });
    console.log(line(check, result, Date.now() - started));
    if (result.status === 'FAILED' && result.errorClass !== 'BUSINESS') failures += 1;
  }
  console.log(failures === 0 ? 'Every call was answered.' : `${failures} check(s) could not be made — see the error classes above (AUTH_CONFIG: keys, signature or IP; NOT_ENABLED: the product is not activated on the account; INSUFFICIENT_BALANCE: the Secure ID wallet).`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error('smoke:secure-id failed:', err instanceof Error ? err.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch(() => undefined);
    redis.disconnect();
  });
