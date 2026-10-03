import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * UPI ID verification through Digio (the owner, 2 Oct 2026).
 *
 * Pinned, with no call leaving the process (every `fetch` is a stub): the
 * request Digio is sent (`check_vpa`, Basic auth, the two ids inside Digio's
 * alphabet and 32 characters, the expected name); each Digio answer read
 * into the layer — available → VERIFIED with the name and score,
 * not_available → BUSINESS VPA_NOT_FOUND, failed → technical, the HTTP
 * classes; the name-match bar; the failover to Cashfree's penny drop ONLY
 * with the holder's fresh consent; the settings default and a stored value
 * kept; and what is kept of the answer (the UPI ID masked).
 */

const kyc = vi.hoisted(() => ({
  config: { clientId: 'digio_client', clientSecret: 'digio_secret', baseUrl: 'https://api.digio.in', kycProvider: 'DIGIO' } as Record<string, unknown>,
}));

vi.mock('../../integrations/integration-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../integrations/integration-config')>()),
  getEffectiveKycConfig: vi.fn(async () => kyc.config),
}));

import { checkDigioVpa, digioRequestId, DIGIO_VPA_PATH } from '../../integrations/digio-client';
import {
  createSecureIdProvider,
  digioUniqueRequestId,
  maskVpa,
  resetVerificationRuntime,
  resolveVerificationSettings,
  routedUpiVpa,
  runCheck,
  verificationRuntime,
  wireVerification,
  type VerificationSettings,
} from '../index';

const SECURE_ID_KEYS = { clientId: 'CF10001', clientSecret: 'cfsk_test_1', testMode: true };
const reply = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)) }) as unknown as Response;
const ABOUT = { caseType: 'PAYOUT_METHOD' as const, caseId: 'cmethod0000000000000000001' };
const NOW = new Date('2026-10-02T10:00:00Z');

const digioAnswer = (status: string, extra: Record<string, unknown> = {}) =>
  reply(200, { virtual_address: 'asha.rao@okhdfc', customer_name: 'ASHA RAO', status, status_description: `VPA asha.rao@okhdfc is ${status}`, fuzzy_match_score: 100, ...extra });

const sentBody = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) => JSON.parse((fetchImpl.mock.calls[call] as unknown as [string, { body: string }])[1].body) as Record<string, unknown>;
const urlOf = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) => (fetchImpl.mock.calls[call] as unknown as [string])[0];

beforeEach(() => {
  vi.clearAllMocks();
  kyc.config = { clientId: 'digio_client', clientSecret: 'digio_secret', baseUrl: 'https://api.digio.in', kycProvider: 'DIGIO' };
  resetVerificationRuntime();
  // Cashfree with fixed keys — the environment's are never read by the suite.
  wireVerification({ providers: { CASHFREE_SECURE_ID: createSecureIdProvider(() => SECURE_ID_KEYS) } });
});

describe('the settings', () => {
  it('default to Digio’s VPA lookup, Digio first and Cashfree second; a stored value is kept as stored', () => {
    const defaults = resolveVerificationSettings(null);
    expect(defaults.upiCheck).toBe('VPA_LOOKUP');
    expect(defaults.checks.UPI_VPA).toEqual({ primary: 'DIGIO', fallbacks: ['CASHFREE_SECURE_ID'] });
    expect(resolveVerificationSettings({}).upiCheck).toBe('VPA_LOOKUP');
    // A value stored before VPA_LOOKUP existed stays what the owner chose.
    expect(resolveVerificationSettings({ upiCheck: 'NONE' }).upiCheck).toBe('NONE');
    expect(resolveVerificationSettings({ upiCheck: 'PENNY_DROP' }).upiCheck).toBe('PENNY_DROP');
    expect(resolveVerificationSettings({ upiCheck: 'REVERSE_PENNY_DROP' }).upiCheck).toBe('REVERSE_PENNY_DROP');
    expect(resolveVerificationSettings({ upiCheck: 'BOGUS' as never }).upiCheck).toBe('VPA_LOOKUP');
    // A stored route for the UPI ID is kept too.
    expect(resolveVerificationSettings({ checks: { UPI_VPA: { primary: 'CASHFREE_SECURE_ID', fallbacks: [] } } }).checks.UPI_VPA).toEqual({ primary: 'CASHFREE_SECURE_ID', fallbacks: [] });
  });

  it('Digio answers the UPI ID only under VPA_LOOKUP; the penny drops stay Cashfree’s', () => {
    const digio = verificationRuntime().providers.DIGIO;
    expect(digio.capabilities(resolveVerificationSettings(null))).toEqual(['HOSTED_KYC', 'UPI_VPA']);
    expect(digio.capabilities(resolveVerificationSettings({ upiCheck: 'PENNY_DROP' }))).toEqual(['HOSTED_KYC']);
    expect(digio.capabilities(resolveVerificationSettings({ upiCheck: 'NONE' }))).toEqual(['HOSTED_KYC']);
  });
});

describe('the Digio client', () => {
  it('POSTs check_vpa on the API host with Basic auth, the two ids, the UPI ID and the expected name', async () => {
    const fetchImpl = vi.fn(async () => digioAnswer('available'));
    const outcome = await checkDigioVpa({ referenceId: 'pm_1:abc', uniqueRequestId: 'va0123456789abcdef0123456789abcd', vpa: ' asha.rao@okhdfc ', name: 'Asha Rao' }, { fetchImpl });
    expect(urlOf(fetchImpl)).toBe(`https://api.digio.in${DIGIO_VPA_PATH}`);
    expect(DIGIO_VPA_PATH).toBe('/v3/client/public/upi/check_vpa');
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${Buffer.from('digio_client:digio_secret').toString('base64')}`);
    expect(sentBody(fetchImpl)).toEqual({ reference_id: 'pm_1abc', unique_request_id: 'va0123456789abcdef0123456789abcd', virtual_address: 'asha.rao@okhdfc', name: 'Asha Rao' });
    expect(outcome).toEqual({ ok: true, httpStatus: 200, answer: { virtualAddress: 'asha.rao@okhdfc', customerName: 'ASHA RAO', status: 'available', statusDescription: 'VPA asha.rao@okhdfc is available', fuzzyMatchScore: 100 } });

    // No name, no `name`.
    const bare = vi.fn(async () => digioAnswer('available'));
    await checkDigioVpa({ referenceId: 'r', uniqueRequestId: 'u', vpa: 'a@b' }, { fetchImpl: bare });
    expect(sentBody(bare)).not.toHaveProperty('name');
  });

  it('keeps the ids inside Digio’s alphabet and 32 characters, and the unique id one per attempt', () => {
    expect(digioRequestId('x'.repeat(40))).toHaveLength(32);
    expect(digioRequestId('a b/c.d')).toBe('abcd');
    expect(digioRequestId('***', 'fallback')).toBe('fallback');
    const minted = 'va0123456789abcdef0123456789abcd';
    expect(digioUniqueRequestId(minted)).toBe(minted);
    const long = digioUniqueRequestId('attempt-'.repeat(8));
    expect(long).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(digioUniqueRequestId('attempt-'.repeat(8) + 'x')).not.toBe(long);
  });

  it('does not call without keys, or while Digio is switched off', async () => {
    const fetchImpl = vi.fn();
    kyc.config = { baseUrl: 'https://api.digio.in' };
    expect(await checkDigioVpa({ referenceId: 'r', uniqueRequestId: 'u', vpa: 'a@b' }, { fetchImpl })).toMatchObject({ ok: false, outage: 'NOT_CONFIGURED' });
    kyc.config = { clientId: 'c', clientSecret: 's', baseUrl: 'https://api.digio.in', kycProvider: 'MANUAL' };
    expect(await checkDigioVpa({ referenceId: 'r', uniqueRequestId: 'u', vpa: 'a@b' }, { fetchImpl })).toMatchObject({ ok: false, outage: 'SWITCHED_OFF' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the Digio provider: each answer', () => {
  const settings: VerificationSettings = resolveVerificationSettings(null);
  const ctx = (fetchImpl: unknown) => ({ verificationId: 'va0123456789abcdef0123456789abcd', attemptNo: 1, caseType: 'PAYOUT_METHOD' as const, caseId: ABOUT.caseId, settings, fetchImpl: fetchImpl as never, now: () => NOW });
  const run = (fetchImpl: unknown, name?: string) => verificationRuntime().providers.DIGIO.run('UPI_VPA', { vpa: 'asha.rao@okhdfc', name }, ctx(fetchImpl));

  it('available → VERIFIED with the name on the UPI ID and, when a name was sent, Digio’s score', async () => {
    expect(await run(vi.fn(async () => digioAnswer('available', { fuzzy_match_score: 92 })), 'Asha Rao')).toMatchObject({
      status: 'VERIFIED',
      provider: 'DIGIO',
      providerRef: 'va0123456789abcdef0123456789abcd',
      matchedName: 'ASHA RAO',
      nameMatchScore: 92,
    });
    // No name sent: no score claimed, even if Digio sent one.
    const unnamed = await run(vi.fn(async () => digioAnswer('available', { fuzzy_match_score: 0 })));
    expect(unnamed).toMatchObject({ status: 'VERIFIED', matchedName: 'ASHA RAO' });
    expect(unnamed.nameMatchScore).toBeUndefined();
  });

  it('not_available → FAILED / BUSINESS VPA_NOT_FOUND (final)', async () => {
    expect(await run(vi.fn(async () => digioAnswer('not_available', { customer_name: null })))).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'VPA_NOT_FOUND' });
  });

  it('failed, a timeout, the network, 5xx, 429, 401/403 and 404 are technical; any other refusal is Digio’s answer', async () => {
    expect(await run(vi.fn(async () => digioAnswer('failed')))).toMatchObject({ status: 'FAILED', errorClass: 'HTTP_5XX', failureCode: 'VPA_LOOKUP_FAILED' });
    const abort = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(await run(vi.fn(async () => Promise.reject(abort)))).toMatchObject({ status: 'FAILED', errorClass: 'TIMEOUT' });
    expect(await run(vi.fn(async () => Promise.reject(new Error('ECONNRESET'))))).toMatchObject({ status: 'FAILED', errorClass: 'NETWORK' });
    expect(await run(vi.fn(async () => reply(502, { code: 'BAD_GATEWAY' })))).toMatchObject({ status: 'FAILED', errorClass: 'HTTP_5XX' });
    expect(await run(vi.fn(async () => reply(429, {})))).toMatchObject({ status: 'FAILED', errorClass: 'RATE_LIMITED' });
    expect(await run(vi.fn(async () => reply(401, { code: 'UNAUTHORIZED' })))).toMatchObject({ status: 'FAILED', errorClass: 'AUTH_CONFIG', failureCode: 'HTTP_401:UNAUTHORIZED' });
    expect(await run(vi.fn(async () => reply(403, {})))).toMatchObject({ status: 'FAILED', errorClass: 'AUTH_CONFIG' });
    expect(await run(vi.fn(async () => reply(404, {})))).toMatchObject({ status: 'FAILED', errorClass: 'NOT_ENABLED' });
    expect(await run(vi.fn(async () => reply(400, { code: 'INVALID_VPA', message: 'asha.rao@okhdfc is not a valid VPA' })))).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'HTTP_400:INVALID_VPA' });
  });

  it('a name under nameMatchMin is FAILED / BUSINESS NAME_MISMATCH with the score kept; at the bar it passes', async () => {
    const low = await run(vi.fn(async () => digioAnswer('available', { fuzzy_match_score: 79 })), 'Asha Rao');
    expect(low).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'NAME_MISMATCH', matchedName: 'ASHA RAO', nameMatchScore: 79 });
    expect(await run(vi.fn(async () => digioAnswer('available', { fuzzy_match_score: 80 })), 'Asha Rao')).toMatchObject({ status: 'VERIFIED', nameMatchScore: 80 });
    // The bar is the setting's.
    const strict = await verificationRuntime().providers.DIGIO.run('UPI_VPA', { vpa: 'asha.rao@okhdfc', name: 'Asha Rao' }, { ...ctx(vi.fn(async () => digioAnswer('available', { fuzzy_match_score: 85 }))), settings: resolveVerificationSettings({ nameMatchMin: 90 }) });
    expect(strict).toMatchObject({ status: 'FAILED', failureCode: 'NAME_MISMATCH', nameMatchScore: 85 });
  });

  it('keeps the UPI ID masked to its handle and the last four before the @, and the name Digio gave — never the name sent', async () => {
    const result = await run(vi.fn(async () => digioAnswer('available', { fuzzy_match_score: 95 })), 'Asha Expected');
    expect(result.raw).toEqual({ mode: 'VPA_LOOKUP', vpa: '••••.rao@okhdfc', status: 'available', statusDescription: 'VPA ••••.rao@okhdfc is available', customerName: 'ASHA RAO', nameSent: true, fuzzyMatchScore: 95 });
    const kept = JSON.stringify(result.raw);
    expect(kept).not.toContain('asha.rao@');
    expect(kept).not.toContain('Asha Expected');
    const refused = await run(vi.fn(async () => reply(400, { code: 'X' })));
    expect(JSON.stringify(refused.raw)).not.toContain('asha.rao@');

    expect(maskVpa('asha.rao@okhdfc')).toBe('••••.rao@okhdfc');
    expect(maskVpa('ab12@upi')).toBe('••••12@upi');
    expect(maskVpa('ab@upi')).toBe('••••@upi');
    expect(maskVpa('')).toBeNull();
  });
});

describe('the route: Digio first, Cashfree only with consent', () => {
  /** One stub for both hosts: Digio's lookup and Cashfree's penny drop. */
  const both = (digio: () => Response | Promise<Response>, cashfree: () => Response | Promise<Response>) =>
    vi.fn(async (url: string) => (url.includes('digio.in') ? digio() : cashfree()));
  const pennyDropValid = () => reply(200, { reference_id: 300, status: 'VALID', vpa: 'asha.rao@okhdfc', name_at_bank: 'ASHA RAO', bank_account: '1234567890', ifsc: 'HDFC0000001', utr: 'UTR9', name_match_score: '100.00' });
  const consent = { obtainedAt: new Date(NOW.getTime() - 60_000), purpose: 'Verifying the payout UPI ID the account holder added' };

  it('Digio’s answer is final: a VPA not found is not asked of Cashfree', async () => {
    const fetchImpl = both(() => digioAnswer('not_available'), pennyDropValid);
    const answer = await routedUpiVpa({ vpa: 'asha.rao@okhdfc', consent }, ABOUT, { fetchImpl, now: () => NOW });
    expect(answer).toMatchObject({ outcome: 'NOT_FOUND', provider: 'DIGIO', failedOver: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('Digio down WITH fresh consent fails over to Cashfree’s penny drop, recorded as a penny drop', async () => {
    const fetchImpl = both(() => reply(503, {}), pennyDropValid);
    const answer = await routedUpiVpa({ vpa: 'asha.rao@okhdfc', name: 'Asha Rao', consent }, ABOUT, { fetchImpl, now: () => NOW });
    expect(answer).toMatchObject({ outcome: 'VERIFIED', provider: 'CASHFREE_SECURE_ID', via: 'PENNY_DROP', nameAtBank: 'ASHA RAO', nameMatchScore: 100, reference: '300', failedOver: true });
    expect(urlOf(fetchImpl, 1)).toBe('https://sandbox.cashfree.com/verification/upi/penny-drop');
    const attempts = await verificationRuntime().attempts.listForCase(ABOUT.caseType, ABOUT.caseId);
    expect(attempts.map((row) => [row.provider, row.status])).toEqual(expect.arrayContaining([['DIGIO', 'FAILED'], ['CASHFREE_SECURE_ID', 'VERIFIED']]));
  });

  it('Digio down WITHOUT consent (or with consent older than five minutes): Cashfree is skipped, not failed — UNAVAILABLE', async () => {
    const fetchImpl = both(() => reply(503, {}), pennyDropValid);
    const answer = await routedUpiVpa({ vpa: 'asha.rao@okhdfc' }, ABOUT, { fetchImpl, now: () => NOW });
    expect(answer).toMatchObject({ outcome: 'UNAVAILABLE', provider: 'DIGIO', failedOver: false, skipped: [{ provider: 'CASHFREE_SECURE_ID', reason: 'NEEDS_CONSENT' }] });
    expect(answer.message).toMatch(/could not be checked/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const attempts = await verificationRuntime().attempts.listForCase(ABOUT.caseType, ABOUT.caseId);
    expect(attempts.every((row) => row.provider === 'DIGIO')).toBe(true);

    const stale = { obtainedAt: new Date(NOW.getTime() - 6 * 60_000), purpose: 'old' };
    const staleRun = await runCheck('UPI_VPA', { vpa: 'asha.rao@okhdfc', consent: stale }, { ...ABOUT, fetchImpl, now: () => NOW });
    expect(staleRun.skipped).toEqual([{ provider: 'CASHFREE_SECURE_ID', reason: 'NEEDS_CONSENT' }]);
  });

  it('a Digio with no keys is skipped for the UPI ID (no mock) and nothing is recorded for it', async () => {
    kyc.config = { baseUrl: 'https://api.digio.in' };
    const fetchImpl = vi.fn();
    const answer = await routedUpiVpa({ vpa: 'asha.rao@okhdfc' }, ABOUT, { fetchImpl, now: () => NOW });
    expect(answer).toMatchObject({ outcome: 'UNAVAILABLE', provider: null, attemptId: null });
    expect(answer.skipped).toEqual([
      { provider: 'DIGIO', reason: 'NOT_CONFIGURED' },
      { provider: 'CASHFREE_SECURE_ID', reason: 'NEEDS_CONSENT' },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a name under the bar is NAME_MISMATCH whoever scored it — Cashfree’s VALID with a low score included', async () => {
    const digio = await routedUpiVpa({ vpa: 'asha.rao@okhdfc', name: 'Asha Rao' }, ABOUT, { fetchImpl: both(() => digioAnswer('available', { fuzzy_match_score: 40, customer_name: 'RAVI KUMAR' }), pennyDropValid), now: () => NOW });
    expect(digio).toMatchObject({ outcome: 'NAME_MISMATCH', provider: 'DIGIO', nameAtBank: 'RAVI KUMAR', nameMatchScore: 40 });
    expect(digio.message).toContain('RAVI KUMAR');

    const lowCashfree = () => reply(200, { reference_id: 301, status: 'VALID', name_at_bank: 'RAVI KUMAR', name_match_score: '40.00' });
    const cashfree = await routedUpiVpa({ vpa: 'asha.rao@okhdfc', name: 'Asha Rao', consent }, ABOUT, { fetchImpl: both(() => reply(500, {}), lowCashfree), now: () => NOW });
    expect(cashfree).toMatchObject({ outcome: 'NAME_MISMATCH', provider: 'CASHFREE_SECURE_ID', nameMatchScore: 40 });
  });

  it('under PENNY_DROP Digio is not asked at all', async () => {
    wireVerification({ settings: async () => resolveVerificationSettings({ upiCheck: 'PENNY_DROP' }) });
    const fetchImpl = both(() => digioAnswer('available'), pennyDropValid);
    const answer = await routedUpiVpa({ vpa: 'asha.rao@okhdfc', consent }, ABOUT, { fetchImpl, now: () => NOW });
    expect(answer).toMatchObject({ outcome: 'VERIFIED', provider: 'CASHFREE_SECURE_ID' });
    expect(answer.skipped).toEqual([{ provider: 'DIGIO', reason: 'NO_CAPABILITY' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
