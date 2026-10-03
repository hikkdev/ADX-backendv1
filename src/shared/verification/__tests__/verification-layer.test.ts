import { constants, generateKeyPairSync, privateDecrypt } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cashfree Phase 1 (the owner, 1 Oct 2026) — the verification layer.
 *
 * Pinned, with no call ever leaving the process (fetch is mocked; the
 * Digio client is mocked): the routing defaults and the composites; the
 * failover matrix — every technical class moves the router on, every
 * BUSINESS answer is final; the breaker's open / half-open / close; the
 * Secure ID wire — the headers, the `x-cf-signature` (RSA-OAEP-SHA1 of
 * `<clientId>.<unixSeconds>`, checked with the private half of a key pair
 * made here), the error classes by status, read retries; each check's
 * answer read into the layer's shape with its PII cut down; DigiLocker's
 * create / status / document, keeping no Aadhaar number; the webhook's
 * signature, the stale timestamp and the de-duplication; the hosted start
 * — a Cashfree session only with the setting ON, `supports: ['CASHFREE']`,
 * the person's own start and no Digio request already out; and the legacy
 * wrappers still answering as they did.
 */

const digio = vi.hoisted(() => ({ requestDigioKyc: vi.fn() }));
vi.mock('../../integrations/digio-client', () => digio);

import { ApiError } from '../../errors/api-error';
import { lookupVehicleRc, verifyBankAccount } from '../../integrations/cashfree-verification';
import {
  BREAKER_COUNTED_CLASSES,
  CHECK_TYPES,
  HostedKycProviderFailed,
  TECHNICAL_ERROR_CLASSES,
  answerStep,
  cfSignature,
  classifySecureIdError,
  createBreaker,
  createSecureIdProvider,
  defaultComposite,
  digilockerDocument,
  memoryBreakerStore,
  openingSteps,
  parseSecureIdEvent,
  resetVerificationRuntime,
  resolveVerificationSettings,
  runCheck,
  refreshAttempt,
  secureIdCall,
  secureIdTuning,
  secureIdWebhookSignature,
  sessionStatusOf,
  startHostedKyc,
  verificationRuntime,
  verifySecureIdWebhook,
  wireVerification,
  type CheckResult,
  type CheckType,
  type ErrorClass,
  type VerificationProvider,
  type VerificationSettings,
} from '../index';

const KEYS = { clientId: 'CF10001', clientSecret: 'cfsk_test_1', testMode: true };
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }) as unknown as Response;
const CASE = { caseType: 'PUBLISHER_KYC' as const, caseId: 'pub_1' };
const DIGIO_REQUEST = { party: 'PUBLISHER' as const, workflowKey: 'PUBLISHER.INDIVIDUAL' as const, referenceId: 'adx-pub_1-1', customerName: 'Asha Rao', customerEmail: 'asha@example.in', customerMobile: '+919876543210' };
const SUBJECT = { name: 'Asha Rao', party: 'PUBLISHER' as const, business: false };
const DIGIO_SESSION = { kycId: 'KID1', accessToken: 'tok', validTill: '2026-10-02T00:00:00.000Z', sdkUrl: 'https://gw/#KID1', mock: false };

/** A provider that answers whatever the test says, for the failover matrix. */
function scripted(name: 'DIGIO' | 'CASHFREE_SECURE_ID', answers: Partial<CheckResult>[], configured = true): VerificationProvider & { calls: number } {
  const provider = {
    name,
    calls: 0,
    capabilities: () => [...CHECK_TYPES],
    configured: async () => configured,
    async run(_check: CheckType, _input: unknown, ctx: { verificationId: string }): Promise<CheckResult> {
      const answer = answers[Math.min(provider.calls, answers.length - 1)] ?? {};
      provider.calls += 1;
      return { status: 'VERIFIED', provider: name, providerRef: `${name}-ref`, verificationId: ctx.verificationId, raw: {}, ...answer };
    },
  };
  return provider;
}

const technical = (errorClass: ErrorClass): Partial<CheckResult> => ({ status: 'FAILED', errorClass, failureCode: errorClass });

beforeEach(() => {
  vi.clearAllMocks();
  resetVerificationRuntime();
  secureIdTuning.readRetryDelaysMs = [0, 0];
  digio.requestDigioKyc.mockResolvedValue(DIGIO_SESSION);
});

describe('the settings', () => {
  it('route HOSTED_KYC to Digio then Cashfree and every other check to Cashfree; a stray value falls back', () => {
    const settings = resolveVerificationSettings(null);
    expect(settings.checks.HOSTED_KYC).toEqual({ primary: 'DIGIO', fallbacks: ['CASHFREE_SECURE_ID'] });
    expect(settings.checks.PAN).toEqual({ primary: 'CASHFREE_SECURE_ID', fallbacks: [] });
    expect(settings.breaker).toEqual({ failures: 5, windowMinutes: 10, cooldownMinutes: 5 });
    expect(settings.nameMatchMin).toBe(80);
    // 2 Oct 2026: Digio's VPA lookup is the UPI check by default, Digio first and Cashfree second.
    expect(settings.upiCheck).toBe('VPA_LOOKUP');
    expect(settings.checks.UPI_VPA).toEqual({ primary: 'DIGIO', fallbacks: ['CASHFREE_SECURE_ID'] });
    expect(settings.hostedKycBackup).toBe('OFF');

    const stored = resolveVerificationSettings({
      checks: { HOSTED_KYC: { primary: 'CASHFREE_SECURE_ID', fallbacks: ['CASHFREE_SECURE_ID', 'DIGIO', 'DIGIO'] }, PAN: { primary: 'NOPE' as never } },
      breaker: { failures: 0, windowMinutes: 30 },
      nameMatchMin: 101,
      upiCheck: 'PENNY_DROP',
      hostedKycBackup: 'ON',
      composites: { AGENT: [{ step: 'PAN' }, { step: 'PAN', required: false }, { step: 'BOGUS' as never }] },
    });
    expect(stored.checks.HOSTED_KYC).toEqual({ primary: 'CASHFREE_SECURE_ID', fallbacks: ['DIGIO'] });
    expect(stored.checks.PAN.primary).toBe('CASHFREE_SECURE_ID');
    expect(stored.breaker).toEqual({ failures: 5, windowMinutes: 30, cooldownMinutes: 5 });
    expect(stored.nameMatchMin).toBe(80);
    expect(stored.upiCheck).toBe('PENNY_DROP');
    expect(stored.hostedKycBackup).toBe('ON');
    expect(stored.composites.AGENT).toEqual([{ step: 'PAN', required: true }]);
  });

  it('the composites: individuals with the bank, advertisers without, businesses with the papers, spots by kind', () => {
    const steps = (key: Parameters<typeof defaultComposite>[0]) => defaultComposite(key).map((step) => `${step.step}${step.required ? '' : '?'}`);
    expect(steps('PUBLISHER.INDIVIDUAL')).toEqual(['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'BANK_ACCOUNT', 'NAME_MATCH']);
    expect(steps('ADVERTISER.INDIVIDUAL')).toEqual(['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH']);
    expect(steps('AGENT')).toEqual(['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'DRIVING_LICENCE', 'VEHICLE_RC', 'BANK_ACCOUNT', 'NAME_MATCH']);
    expect(steps('EMPLOYEE.INTERN_CONTRACT')).toEqual(['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'BANK_ACCOUNT', 'NAME_MATCH']);
    expect(steps('PUBLISHER.COMPANY')).toEqual(['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'PAN', 'GSTIN?', 'PAPERS', 'BANK_ACCOUNT', 'NAME_MATCH']);
    expect(steps('PRINT_PARTNER.LLP_PARTNERSHIP')).toEqual(['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'PAN', 'GSTIN', 'PAPERS', 'BANK_ACCOUNT', 'NAME_MATCH']);
    expect(steps('ADVERTISER.POLITICAL')).toEqual(['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'PAN', 'GSTIN?', 'PAPERS']);
    expect(steps('SPOT.TRANSIT')).toEqual(['VEHICLE_RC']);
    expect(steps('SPOT.OUTDOOR')).toEqual(['PAPERS']);
  });

  it('the outcome rule: an individual passing every step is VERIFIED; papers go to review; a third no fails; an optional step never holds', () => {
    const at = new Date();
    let steps = openingSteps(defaultComposite('ADVERTISER.INDIVIDUAL'));
    expect(sessionStatusOf(steps)).toBe('OPEN');
    steps = answerStep(steps, 'DIGILOCKER', { status: 'PENDING', attemptId: 'a1', at });
    expect(sessionStatusOf(steps)).toBe('NEEDS_USER_ACTION');
    steps = answerStep(steps, 'DIGILOCKER', { status: 'VERIFIED', attemptId: 'a1', at });
    steps = answerStep(steps, 'FACE_LIVENESS', { status: 'VERIFIED', attemptId: 'a2', at });
    steps = answerStep(steps, 'FACE_MATCH', { status: 'FAILED', attemptId: 'a3', at, failureCode: 'FACE_MISMATCH' });
    expect(sessionStatusOf(steps)).toBe('OPEN');
    expect(steps.find((s) => s.check === 'FACE_MATCH')).toMatchObject({ tries: 1, failureCode: 'FACE_MISMATCH' });
    steps = answerStep(steps, 'FACE_MATCH', { status: 'VERIFIED', attemptId: 'a4', at });
    expect(sessionStatusOf(steps)).toBe('VERIFIED');

    let business = openingSteps(defaultComposite('PUBLISHER.COMPANY'));
    expect(business.find((s) => s.check === 'PAPERS')?.status).toBe('REVIEW');
    for (const check of ['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'PAN', 'BANK_ACCOUNT', 'NAME_MATCH'] as const) business = answerStep(business, check, { status: 'VERIFIED', attemptId: 'x', at });
    // GSTIN is optional for a publisher: not answered, and the session still goes to the desk.
    expect(sessionStatusOf(business)).toBe('IN_REVIEW');

    let failing = openingSteps(defaultComposite('ADVERTISER.INDIVIDUAL'));
    for (let i = 0; i < 3; i += 1) failing = answerStep(failing, 'DIGILOCKER', { status: 'FAILED', attemptId: `f${i}`, at, failureCode: 'CONSENT_DENIED' });
    expect(sessionStatusOf(failing)).toBe('FAILED');
  });
});

describe('the router', () => {
  it.each(TECHNICAL_ERROR_CLASSES)('%s on the primary moves the router on; the attempt says it failed over', async (errorClass) => {
    const primary = scripted('DIGIO', [technical(errorClass)]);
    const backup = scripted('CASHFREE_SECURE_ID', [{ status: 'VERIFIED' }]);
    wireVerification({ providers: { DIGIO: primary, CASHFREE_SECURE_ID: backup } });
    const routed = await runCheck('HOSTED_KYC', { digio: DIGIO_REQUEST }, CASE);
    expect(routed.result?.provider).toBe('CASHFREE_SECURE_ID');
    expect(routed.result?.status).toBe('VERIFIED');
    expect(routed.failedOver).toBe(true);
    expect(routed.attempts.map((a) => [a.provider, a.status, a.errorClass])).toEqual([
      ['DIGIO', 'FAILED', errorClass],
      ['CASHFREE_SECURE_ID', 'VERIFIED', null],
    ]);
    expect(routed.attempts[0]?.attemptNo).toBe(1);
    expect((await verificationRuntime().attempts.find(routed.attempts[0]!.id))?.result).toMatchObject({ failedOverTo: 'CASHFREE_SECURE_ID' });
  });

  it('a BUSINESS answer is final — the backup is never asked', async () => {
    const primary = scripted('DIGIO', [{ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'HTTP_400' }]);
    const backup = scripted('CASHFREE_SECURE_ID', [{ status: 'VERIFIED' }]);
    wireVerification({ providers: { DIGIO: primary, CASHFREE_SECURE_ID: backup } });
    const routed = await runCheck('HOSTED_KYC', { digio: DIGIO_REQUEST }, CASE);
    expect(routed.result).toMatchObject({ provider: 'DIGIO', status: 'FAILED', errorClass: 'BUSINESS' });
    expect(backup.calls).toBe(0);
    expect(routed.failedOver).toBe(false);
    expect(routed.attempts).toHaveLength(1);
  });

  it('skips a provider without the capability, one with no keys, and one whose breaker is open — recording nothing for a skip', async () => {
    const digioOnly = { ...scripted('DIGIO', [{ status: 'VERIFIED' }]), capabilities: () => ['HOSTED_KYC' as const] };
    const unconfigured = scripted('CASHFREE_SECURE_ID', [{ status: 'VERIFIED' }], false);
    wireVerification({ providers: { DIGIO: digioOnly, CASHFREE_SECURE_ID: unconfigured } });
    const routed = await runCheck('PAN', { pan: 'ABCPV1234D' }, CASE);
    expect(routed.result).toBeNull();
    expect(routed.attempts).toEqual([]);
    expect(routed.skipped).toEqual([{ provider: 'CASHFREE_SECURE_ID', reason: 'NOT_CONFIGURED' }]);

    const settings = resolveVerificationSettings({ breaker: { failures: 1 } });
    wireVerification({ settings: async () => settings, providers: { CASHFREE_SECURE_ID: scripted('CASHFREE_SECURE_ID', [technical('TIMEOUT')]) } });
    expect((await runCheck('PAN', { pan: 'ABCPV1234D' }, CASE)).result?.errorClass).toBe('TIMEOUT');
    const second = await runCheck('PAN', { pan: 'ABCPV1234D' }, CASE);
    expect(second.result).toBeNull();
    expect(second.skipped).toEqual([{ provider: 'CASHFREE_SECURE_ID', reason: 'CIRCUIT_OPEN' }]);
  });

  it('a provider that throws is recorded as a NETWORK failure and failed over', async () => {
    const primary = { ...scripted('DIGIO', []), run: async () => Promise.reject(new TypeError('boom')) };
    wireVerification({ providers: { DIGIO: primary, CASHFREE_SECURE_ID: scripted('CASHFREE_SECURE_ID', [{ status: 'VERIFIED' }]) } });
    const routed = await runCheck('HOSTED_KYC', { digio: DIGIO_REQUEST }, CASE);
    expect(routed.attempts[0]).toMatchObject({ provider: 'DIGIO', status: 'FAILED', errorClass: 'NETWORK', failureCode: 'PROVIDER_THREW' });
    expect(routed.result?.provider).toBe('CASHFREE_SECURE_ID');
  });

  it('the attempt is the verification_id, PII-minimised, and never carries what is transient', async () => {
    const provider = scripted('CASHFREE_SECURE_ID', [{ status: 'VERIFIED', raw: { pan: '••••234D' }, transient: { secret: 'never' }, userAction: { kind: 'REDIRECT', url: 'https://x', expiresAt: null } }]);
    wireVerification({ providers: { CASHFREE_SECURE_ID: provider } });
    const routed = await runCheck('PAN', { pan: 'ABCPV1234D' }, CASE);
    const row = await verificationRuntime().attempts.find(routed.attemptId!);
    expect(row?.verificationId).toBe(row?.id);
    expect(row?.id).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(row?.result).toEqual({ pan: '••••234D' });
    expect(JSON.stringify(row)).not.toContain('never');
    expect(JSON.stringify(row)).not.toContain('https://x');
  });
});

describe('the breaker', () => {
  it('opens after N counted failures in the window, half-opens one probe after the cooldown, closes on its success and reopens on its failure', async () => {
    let clock = 1_000_000;
    const breaker = createBreaker(memoryBreakerStore(() => clock), () => clock);
    const settings = { failures: 3, windowMinutes: 10, cooldownMinutes: 5 };
    expect(await breaker.pass('DIGIO', settings)).toBe('CLOSED');
    expect(await breaker.failure('DIGIO', settings)).toBe('CLOSED');
    expect(await breaker.failure('DIGIO', settings)).toBe('CLOSED');
    expect(await breaker.failure('DIGIO', settings)).toBe('OPEN');
    expect(await breaker.pass('DIGIO', settings)).toBe('OPEN');
    expect((await breaker.view('DIGIO', settings)).state).toBe('OPEN');

    clock += 5 * 60_000 + 1;
    expect((await breaker.view('DIGIO', settings)).state).toBe('HALF_OPEN');
    expect(await breaker.pass('DIGIO', settings)).toBe('PROBE');
    // A second caller while the probe is out waits.
    expect(await breaker.pass('DIGIO', settings)).toBe('OPEN');
    expect(await breaker.failure('DIGIO', settings)).toBe('OPEN');
    expect(await breaker.pass('DIGIO', settings)).toBe('OPEN');

    clock += 5 * 60_000 + 1;
    expect(await breaker.pass('DIGIO', settings)).toBe('PROBE');
    await breaker.success('DIGIO');
    expect(await breaker.pass('DIGIO', settings)).toBe('CLOSED');
    expect((await breaker.view('DIGIO', settings)).state).toBe('CLOSED');
  });

  it('failures outside the window are forgotten, and only the counted classes count', async () => {
    let clock = 0;
    const breaker = createBreaker(memoryBreakerStore(() => clock), () => clock);
    const settings = { failures: 2, windowMinutes: 1, cooldownMinutes: 1 };
    await breaker.failure('CASHFREE_SECURE_ID', settings);
    clock += 61_000;
    expect(await breaker.failure('CASHFREE_SECURE_ID', settings)).toBe('CLOSED');
    expect(BREAKER_COUNTED_CLASSES).toEqual(['TIMEOUT', 'NETWORK', 'HTTP_5XX', 'RATE_LIMITED', 'AUTH_CONFIG', 'INSUFFICIENT_BALANCE']);
    expect(BREAKER_COUNTED_CLASSES).not.toContain('NOT_ENABLED');
    expect(BREAKER_COUNTED_CLASSES).not.toContain('PROVIDER_SWITCHED_OFF');
  });

  it('through the router: a switched-off Digio does not count, five timeouts do', async () => {
    const settings = resolveVerificationSettings(null);
    wireVerification({ settings: async () => settings, providers: { CASHFREE_SECURE_ID: scripted('CASHFREE_SECURE_ID', [technical('NOT_ENABLED')]) } });
    for (let i = 0; i < 6; i += 1) await runCheck('DIGILOCKER', { documents: ['AADHAAR'] }, CASE);
    expect((await verificationRuntime().breaker.view('CASHFREE_SECURE_ID', settings.breaker)).state).toBe('CLOSED');
    wireVerification({ providers: { CASHFREE_SECURE_ID: scripted('CASHFREE_SECURE_ID', [technical('TIMEOUT')]) } });
    for (let i = 0; i < 5; i += 1) await runCheck('PAN', { pan: 'ABCPV1234D' }, CASE);
    expect((await verificationRuntime().breaker.view('CASHFREE_SECURE_ID', settings.breaker)).state).toBe('OPEN');
  });
});

describe('the Secure ID wire', () => {
  it('signs <clientId>.<unixSeconds> with RSA-OAEP-SHA1 under the public key — the private half opens it', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const now = new Date('2026-10-01T10:00:00Z');
    const signature = cfSignature('CF10001', pem, now);
    const opened = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(signature, 'base64')).toString('utf8');
    expect(opened).toBe(`CF10001.${Math.floor(now.getTime() / 1000)}`);
    expect(Buffer.from(signature, 'base64').length).toBe(256);
  });

  it('sends the three headers on every call, the signature only with a public key, the sandbox host under test mode', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const fetchImpl = vi.fn(async () => reply(200, { valid: true }));
    await secureIdCall({ check: 'PAN', method: 'POST', path: '/pan', json: { pan: 'ABCPV1234D' } }, KEYS, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; method: string }];
    expect(url).toBe('https://sandbox.cashfree.com/verification/pan');
    expect(init.headers).toMatchObject({ 'x-client-id': 'CF10001', 'x-client-secret': 'cfsk_test_1', 'x-api-version': '2024-12-01', 'Content-Type': 'application/json' });
    expect(init.headers['x-cf-signature']).toBeUndefined();

    await secureIdCall({ check: 'PAN', method: 'POST', path: '/pan', json: {} }, { ...KEYS, publicKey: pem, testMode: false }, fetchImpl);
    const [liveUrl, liveInit] = fetchImpl.mock.calls[1] as unknown as [string, { headers: Record<string, string> }];
    expect(liveUrl).toBe('https://api.cashfree.com/verification/pan');
    expect(liveInit.headers['x-cf-signature']).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const bad = await secureIdCall({ check: 'PAN', method: 'POST', path: '/pan', json: {} }, { ...KEYS, publicKey: 'not a key' }, fetchImpl);
    expect(bad).toMatchObject({ ok: false, errorClass: 'AUTH_CONFIG', code: 'PUBLIC_KEY_INVALID' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const none = await secureIdCall({ check: 'PAN', method: 'POST', path: '/pan', json: {} }, { testMode: true }, fetchImpl);
    expect(none).toMatchObject({ ok: false, errorClass: 'AUTH_CONFIG', code: 'NOT_CONFIGURED' });
  });

  it.each([
    [401, { code: 'authentication_failed' }, 'AUTH_CONFIG'],
    [403, { code: 'ip_validation_failed' }, 'AUTH_CONFIG'],
    [403, { code: 'authentication_failed', message: 'x-cf-signature missing in the request header' }, 'AUTH_CONFIG'],
    [429, { code: 'too_many_requests_per_ip' }, 'RATE_LIMITED'],
    [429, { code: 'rate_limit_exceeded', type: 'invalid_request_error' }, 'RATE_LIMITED'],
    [500, { code: 'verification_failed' }, 'HTTP_5XX'],
    [502, { code: 'verification_failed' }, 'HTTP_5XX'],
    [422, { code: 'insufficient_balance' }, 'INSUFFICIENT_BALANCE'],
    [422, { code: 'npci_unavailable' }, 'HTTP_5XX'],
    [422, { code: 'fraud_account' }, 'BUSINESS'],
    [404, {}, 'NOT_ENABLED'],
    [404, { type: 'not_found_error', code: 'referenceId_not_found' }, 'BUSINESS'],
    [400, { code: 'invalid_request', message: 'service not enabled for this account.' }, 'NOT_ENABLED'],
    [400, { code: 'x-client-secret_value_invalid', message: 'Client secret belongs to test environment' }, 'AUTH_CONFIG'],
    [400, { code: 'pan_length_short', message: 'Enter valid PAN.' }, 'BUSINESS'],
    [409, { code: 'verification_id_already_exists' }, 'HTTP_5XX'],
  ] as const)('%s %j → %s', (status, body, errorClass) => {
    expect(classifySecureIdError(status, body as Record<string, unknown>)).toBe(errorClass);
  });

  it('retries a read that timed out or hit a 5xx, never a write; a timeout is TIMEOUT, a dead socket NETWORK', async () => {
    let calls = 0;
    const flaky = vi.fn(async () => (calls++ < 2 ? reply(503, { code: 'request_failed' }) : reply(200, { status: 'VALID' })));
    const read = await secureIdCall({ check: 'VEHICLE_RC', method: 'GET', path: '/vehicle-rc', query: { verification_id: 'v1' } }, KEYS, flaky);
    expect(read.ok).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(3);
    expect((flaky.mock.calls[0] as unknown as [string])[0]).toBe('https://sandbox.cashfree.com/verification/vehicle-rc?verification_id=v1');

    const writeDown = vi.fn(async () => reply(503, { code: 'request_failed' }));
    expect(await secureIdCall({ check: 'PAN', method: 'POST', path: '/pan', json: {} }, KEYS, writeDown)).toMatchObject({ ok: false, errorClass: 'HTTP_5XX', status: 503 });
    expect(writeDown).toHaveBeenCalledTimes(1);

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(await secureIdCall({ check: 'PAN', method: 'POST', path: '/pan', json: {} }, KEYS, vi.fn(async () => Promise.reject(abort)))).toMatchObject({ ok: false, errorClass: 'TIMEOUT' });
    expect(await secureIdCall({ check: 'PAN', method: 'POST', path: '/pan', json: {} }, KEYS, vi.fn(async () => Promise.reject(new Error('ECONNRESET'))))).toMatchObject({ ok: false, errorClass: 'NETWORK', message: 'ECONNRESET' });
  });
});

describe('the Cashfree Secure ID provider', () => {
  const settings: VerificationSettings = resolveVerificationSettings({ upiCheck: 'PENNY_DROP' });
  const ctx = (fetchImpl: (input: string, init: RequestInit) => Promise<Response>) => ({ verificationId: 'va0123456789abcdef0123456789abcd', attemptNo: 1, caseType: 'PUBLISHER_KYC' as const, caseId: 'pub_1', settings, fetchImpl, now: () => new Date('2026-10-01T10:00:00Z') });
  const provider = createSecureIdProvider(() => KEYS);
  const sent = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) => JSON.parse((fetchImpl.mock.calls[call] as unknown as [string, { body: string }])[1].body as string) as Record<string, unknown>;

  it('has no UPI capability while the UPI check is NONE', () => {
    expect(provider.capabilities(resolveVerificationSettings({ upiCheck: 'NONE' }))).not.toContain('UPI_VPA');
    expect(provider.capabilities(settings)).toContain('UPI_VPA');
    expect(provider.capabilities(settings)).toContain('HOSTED_KYC');
  });

  it('PAN: POST /pan — valid is VERIFIED with the registered name and the 0–100 score; invalid is a BUSINESS no; the number is masked', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { pan: 'ABCPV1234D', type: 'Individual', reference_id: 1234, valid: true, registered_name: 'ASHA RAO', name_match_score: '85.00', name_match_result: 'GOOD_PARTIAL_MATCH', pan_status: 'VALID', aadhaar_seeding_status: 'Y' }));
    const result = await provider.run('PAN', { pan: 'abcpv1234d', name: 'Asha Rao' }, ctx(fetchImpl));
    expect(sent(fetchImpl)).toEqual({ pan: 'ABCPV1234D', name: 'Asha Rao' });
    expect(result).toMatchObject({ status: 'VERIFIED', providerRef: '1234', matchedName: 'ASHA RAO', nameMatchScore: 85, raw: { pan: '••••234D', valid: true, panStatus: 'VALID' } });
    expect(JSON.stringify(result.raw)).not.toContain('ABCPV1234D');

    const invalid = await provider.run('PAN', { pan: 'DEFPV0126D' }, ctx(vi.fn(async () => reply(200, { pan: 'DEFPV0126D', reference_id: 1235, valid: false, message: 'Invalid PAN', pan_status: 'INVALID', name_match_result: '-' }))));
    expect(invalid).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'PAN_INVALID', nameMatchScore: undefined });
  });

  it('bank: POST /bank-account/sync — VALID is VERIFIED with the name at bank; INVALID a BUSINESS no; the bank being down is technical; async reads back by reference', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { reference_id: 55, name_at_bank: 'ASHA RAO', bank_name: 'HDFC Bank', account_status: 'VALID', account_status_code: 'ACCOUNT_IS_VALID', name_match_score: '92.50', name_match_result: 'GOOD_PARTIAL_MATCH', utr: 'UTR1' }));
    const result = await provider.run('BANK_ACCOUNT', { accountNumber: '1234 5678 90', ifsc: 'hdfc0001234', name: 'Asha Rao', phone: '+919000000777' }, ctx(fetchImpl));
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://sandbox.cashfree.com/verification/bank-account/sync');
    expect(sent(fetchImpl)).toEqual({ bank_account: '1234567890', ifsc: 'HDFC0001234', name: 'Asha Rao', phone: '9000000777' });
    expect(result).toMatchObject({ status: 'VERIFIED', providerRef: '55', matchedName: 'ASHA RAO', nameMatchScore: 92.5, raw: { account: '••••7890', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank', utr: 'UTR1' } });
    expect(JSON.stringify(result.raw)).not.toContain('1234567890');
    expect((result.transient as { facts: { valid: boolean } }).facts.valid).toBe(true);

    expect(await provider.run('BANK_ACCOUNT', { accountNumber: '026291800001190', ifsc: 'YESB0000262' }, ctx(vi.fn(async () => reply(200, { reference_id: 56, account_status: 'INVALID', account_status_code: 'INVALID_ACCOUNT_FAIL' }))))).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'INVALID_ACCOUNT_FAIL' });
    expect(await provider.run('BANK_ACCOUNT', { accountNumber: '000100289877623', ifsc: 'SBIN0008752' }, ctx(vi.fn(async () => reply(200, { reference_id: 57, account_status: 'FAILED', account_status_code: 'FAILED_AT_BANK' }))))).toMatchObject({ status: 'FAILED', errorClass: 'HTTP_5XX' });
    expect(await provider.run('BANK_ACCOUNT', { accountNumber: '000100289877623', ifsc: 'SBIN0008752' }, ctx(vi.fn(async () => reply(422, { code: 'insufficient_balance', message: 'Insufficient balance to process this request' }))))).toMatchObject({ status: 'FAILED', errorClass: 'INSUFFICIENT_BALANCE' });

    const asyncFetch = vi.fn(async () => reply(200, { reference_id: 58, user_id: 'va0123456789abcdef0123456789abcd', account_status: 'RECEIVED', account_status_code: 'VALIDATION_IN_PROGRESS' }));
    const pending = await provider.run('BANK_ACCOUNT', { accountNumber: '00011020001772', ifsc: 'HDFC0000001', mode: 'ASYNC' }, ctx(asyncFetch));
    expect((asyncFetch.mock.calls[0] as unknown as [string])[0]).toBe('https://sandbox.cashfree.com/verification/bank-account/async');
    expect(sent(asyncFetch)['user_id']).toBe('va0123456789abcdef0123456789abcd');
    expect(pending).toMatchObject({ status: 'PENDING', providerRef: '58' });
    const readFetch = vi.fn(async () => reply(200, { reference_id: 58, account_status: 'VALID', account_status_code: 'ACCOUNT_IS_VALID', name_at_bank: 'ASHA RAO' }));
    const read = await provider.refresh!({ checkType: 'BANK_ACCOUNT', verificationId: 'va0123456789abcdef0123456789abcd', providerRef: '58', result: pending.raw }, ctx(readFetch));
    expect((readFetch.mock.calls[0] as unknown as [string])[0]).toBe('https://sandbox.cashfree.com/verification/bank-account?reference_id=58');
    expect(read).toMatchObject({ status: 'VERIFIED', matchedName: 'ASHA RAO', raw: { account: '••••1772' } });
  });

  it('GSTIN: POST /gstin with the upper-case key — exists is VERIFIED with the legal name; a GSTIN that does not exist is a BUSINESS no', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { reference_id: 9, GSTIN: '29AAICP2912R1ZR', legal_name_of_business: 'ASTER HOMES PRIVATE LIMITED', trade_name_of_business: 'Aster Homes', gst_in_status: 'Active', valid: true, message: 'GSTIN Exists' }));
    const result = await provider.run('GSTIN', { gstin: '29aaicp2912r1zr', businessName: 'Aster Homes' }, ctx(fetchImpl));
    expect(sent(fetchImpl)).toEqual({ GSTIN: '29AAICP2912R1ZR', business_name: 'Aster Homes' });
    expect(result).toMatchObject({ status: 'VERIFIED', matchedName: 'ASTER HOMES PRIVATE LIMITED', raw: { gstStatus: 'Active', tradeName: 'Aster Homes' } });
    expect(await provider.run('GSTIN', { gstin: '29AAIZP2912R1ZR' }, ctx(vi.fn(async () => reply(200, { reference_id: 10, GSTIN: '29AAIZP2912R1ZR', message: "GSTIN Doesn't Exist" }))))).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'GSTIN_NOT_FOUND' });
  });

  it('vehicle RC: POST /vehicle-rc with our id — VALID is VERIFIED with the facts in memory; INVALID a BUSINESS no with the facts still readable; a 409 reads the status back', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { verification_id: 'va0123456789abcdef0123456789abcd', reference_id: 77, status: 'VALID', reg_no: 'HJ01ME5678', owner: 'DEEPAK RAO', owner_father_name: 'X', present_address: 'somewhere', class: 'M-Cycle/Scooter(2WN)', vehicle_manufacturer_name: 'HONDA', model: 'ACTIVA', rc_status: 'ACTIVE', mobile_number: '9999' }));
    const result = await provider.run('VEHICLE_RC', { vehicleNumber: 'hj 01 me-5678' }, ctx(fetchImpl));
    expect(sent(fetchImpl)).toEqual({ verification_id: 'va0123456789abcdef0123456789abcd', vehicle_number: 'HJ01ME5678' });
    expect(result).toMatchObject({ status: 'VERIFIED', providerRef: '77', matchedName: 'DEEPAK RAO', raw: { registrationNumber: 'HJ01ME5678', ownerName: 'DEEPAK RAO', maker: 'HONDA', vehicleClass: 'M-Cycle/Scooter(2WN)' } });
    expect(result.raw).not.toHaveProperty('presentAddress');
    expect(JSON.stringify(result.raw)).not.toContain('somewhere');
    expect((result.transient as { facts: { presentAddress: string } }).facts.presentAddress).toBe('somewhere');

    const invalid = await provider.run('VEHICLE_RC', { vehicleNumber: 'HJ01ME5279' }, ctx(vi.fn(async () => reply(200, { verification_id: 'x', reference_id: 78, status: 'INVALID', is_commercial: false }))));
    expect(invalid).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'RC_INVALID' });
    expect((invalid.transient as { facts: { status: string } }).facts.status).toBe('INVALID');

    let n = 0;
    const dup = vi.fn(async () => (n++ === 0 ? reply(409, { code: 'verification_id_already_exists' }) : reply(200, { reference_id: 79, status: 'VALID', reg_no: 'HJ01ME5678' })));
    expect(await provider.run('VEHICLE_RC', { vehicleNumber: 'HJ01ME5678' }, ctx(dup))).toMatchObject({ status: 'VERIFIED', providerRef: '79' });
    expect((dup.mock.calls[1] as unknown as [string, { method: string }])[1].method).toBe('GET');
  });

  it('driving licence: POST /driving-license with dl_number and dob — VALID with the name; the number masked', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { verification_id: 'x', reference_id: 80, dl_number: 'KA0120198900984', dob: '1994-08-05', status: 'VALID', details_of_driving_licence: { name: 'RAHUL MENON', date_of_issue: '12/03/2019', address: 'nope', photo: 'base64' }, dl_validity: { non_transport: { from: '12/03/2019', to: '11/03/2039' }, transport: { from: '', to: '' } } }));
    const result = await provider.run('DRIVING_LICENCE', { dlNumber: 'ka01 20198900984', dob: '1994-08-05' }, ctx(fetchImpl));
    expect(sent(fetchImpl)).toEqual({ verification_id: 'va0123456789abcdef0123456789abcd', dl_number: 'KA0120198900984', dob: '1994-08-05' });
    expect(result).toMatchObject({ status: 'VERIFIED', matchedName: 'RAHUL MENON', raw: { dlNumber: '••••0984', nonTransportValidUntil: '11/03/2039' } });
    expect(JSON.stringify(result.raw)).not.toContain('base64');
    expect(await provider.run('DRIVING_LICENCE', { dlNumber: 'KA2320238908787', dob: '1987-09-04' }, ctx(vi.fn(async () => reply(200, { status: 'INVALID' }))))).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'DL_INVALID' });
  });

  it('face liveness and face match go as multipart with our id; SUCCESS + liveness is VERIFIED; NO is a BUSINESS no; only the verdicts are kept', async () => {
    const image = { bytes: Buffer.from('jpegbytes'), mime: 'image/jpeg' as const };
    const live = vi.fn(async () => reply(200, { reference_id: 90, verification_id: 'x', status: 'SUCCESS', liveness: true, liveness_score: 0.98, gender: { value: 'F', confidence: 99 }, age_range: { min: 25, max: 32 } }));
    const liveness = await provider.run('FACE_LIVENESS', { image }, ctx(live));
    const [url, init] = live.mock.calls[0] as unknown as [string, { body: FormData; headers: Record<string, string> }];
    expect(url).toBe('https://sandbox.cashfree.com/verification/face-liveness');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('verification_id')).toBe('va0123456789abcdef0123456789abcd');
    expect(init.body.get('image')).toBeInstanceOf(Blob);
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers['x-api-version']).toBe('2024-12-01');
    expect(liveness).toMatchObject({ status: 'VERIFIED', raw: { status: 'SUCCESS', liveness: true, livenessScore: 0.98 } });
    expect(liveness.raw).not.toHaveProperty('gender');
    expect(await provider.run('FACE_LIVENESS', { image }, ctx(vi.fn(async () => reply(200, { status: 'REAL_FACE_NOT_DETECTED', liveness: false, liveness_score: 0 }))))).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'REAL_FACE_NOT_DETECTED' });

    const match = vi.fn(async () => reply(200, { status: 'SUCCESS', ref_id: 91, verification_id: 'x', face_match_result: 'YES', face_match_score: 0.91 }));
    const matched = await provider.run('FACE_MATCH', { first: image, second: image, threshold: 0.8 }, ctx(match));
    const form = (match.mock.calls[0] as unknown as [string, { body: FormData }])[1].body;
    expect(form.get('first_image')).toBeInstanceOf(Blob);
    expect(form.get('second_image')).toBeInstanceOf(Blob);
    expect(form.get('threshold')).toBe('0.8');
    expect(matched).toMatchObject({ status: 'VERIFIED', providerRef: '91', raw: { result: 'YES', score: 0.91 } });
    expect(await provider.run('FACE_MATCH', { first: image, second: image }, ctx(vi.fn(async () => reply(200, { status: 'SUCCESS', ref_id: 92, face_match_result: 'NO', face_match_score: 0.2 }))))).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'FACE_MISMATCH' });
  });

  it('name match: the 0–1 score becomes 0–100 and is held to nameMatchMin', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { verification_id: 'x', reference_id: 100, name_1: 'JOHN DOE', name_2: 'JOHN DE', status: 'SUCCESS', score: 0.93, reason: 'GOOD_PARTIAL_MATCH' }));
    const result = await provider.run('NAME_MATCH', { name1: 'JOHN DOE', name2: 'JOHN DE' }, ctx(fetchImpl));
    expect(sent(fetchImpl)).toEqual({ verification_id: 'va0123456789abcdef0123456789abcd', name_1: 'JOHN DOE', name_2: 'JOHN DE' });
    expect(result).toMatchObject({ status: 'VERIFIED', nameMatchScore: 93, raw: { score: 93, reason: 'GOOD_PARTIAL_MATCH' } });
    const low = await provider.run('NAME_MATCH', { name1: 'JOHN DOE', name2: 'JOHN' }, ctx(vi.fn(async () => reply(200, { status: 'SUCCESS', score: 0.77, reason: 'MODERATE_PARTIAL_MATCH' }))));
    expect(low).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'NAME_MISMATCH', nameMatchScore: 77 });
  });

  it('DigiLocker: the page, the status, the documents — and never the Aadhaar number, the photo or the XML', async () => {
    const create = vi.fn(async () => reply(200, { verification_id: 'x', reference_id: 200, url: 'https://verification-test.cashfree.com/dgl/h7562ci7us0', status: 'PENDING', document_requested: ['AADHAAR', 'PAN'] }));
    const started = await provider.run('DIGILOCKER', { documents: ['AADHAAR', 'PAN'], redirectUrl: 'https://adx.in/verify/back' }, ctx(create));
    expect(sent(create)).toEqual({ verification_id: 'va0123456789abcdef0123456789abcd', document_requested: ['AADHAAR', 'PAN'], redirect_url: 'https://adx.in/verify/back' });
    expect(started).toMatchObject({ status: 'NEEDS_USER_ACTION', providerRef: '200', userAction: { kind: 'REDIRECT', url: 'https://verification-test.cashfree.com/dgl/h7562ci7us0', expiresAt: '2026-10-01T10:10:00.000Z' } });

    const attempt = { checkType: 'DIGILOCKER' as const, verificationId: 'va0123456789abcdef0123456789abcd', providerRef: '200', result: started.raw };
    const pending = await provider.refresh!(attempt, ctx(vi.fn(async () => reply(200, { status: 'PENDING', document_requested: ['AADHAAR', 'PAN'], verification_id: 'x', reference_id: 200 }))));
    expect(pending.status).toBe('NEEDS_USER_ACTION');
    const denied = await provider.refresh!(attempt, ctx(vi.fn(async () => reply(200, { status: 'CONSENT_DENIED', verification_id: 'x', reference_id: 200 }))));
    expect(denied).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'CONSENT_DENIED' });
    const expired = await provider.refresh!(attempt, ctx(vi.fn(async () => reply(200, { status: 'EXPIRED' }))));
    expect(expired).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'DIGILOCKER_EXPIRED' });
    const failure = await provider.refresh!(attempt, ctx(vi.fn(async () => reply(200, { status: 'FAILURE' }))));
    expect(failure).toMatchObject({ status: 'FAILED', errorClass: 'HTTP_5XX' });

    const calls: string[] = [];
    const authenticated = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/digilocker/document/AADHAAR')) return reply(200, { reference_id: 200, verification_id: 'x', status: 'SUCCESS', uid: 'xxxxxxxx5647', care_of: 'S/O Rao', dob: '15-08-1994', gender: 'F', name: 'ASHA RAO', photo_link: Buffer.from('jpeg').toString('base64'), split_address: { pincode: '560001' }, year_of_birth: '1994', xml_file: 'https://zip/expires' });
      if (url.includes('/digilocker/document/PAN')) return reply(200, { reference_id: 200, verification_id: 'x', status: 'SUCCESS', pan: 'ABCPV1234D', type: 'Individual', dob: '15-08-1994', name_pan_card: 'ASHA RAO' });
      return reply(200, { user_details: { name: 'ASHA RAO', dob: '15-08-1994', gender: 'F', eaadhaar: 'Y', mobile: '9876543210' }, status: 'AUTHENTICATED', document_requested: ['AADHAAR', 'PAN'], document_consent: ['AADHAAR', 'PAN'], document_consent_validity: '2026-10-01T11:00:00Z', verification_id: 'x', reference_id: 200 });
    });
    const verified = await provider.refresh!(attempt, ctx(authenticated));
    expect(calls.map((url) => url.replace('https://sandbox.cashfree.com/verification', ''))).toEqual(['/digilocker?verification_id=va0123456789abcdef0123456789abcd', '/digilocker/document/AADHAAR?verification_id=va0123456789abcdef0123456789abcd', '/digilocker/document/PAN?verification_id=va0123456789abcdef0123456789abcd']);
    expect(verified).toMatchObject({ status: 'VERIFIED', matchedName: 'ASHA RAO', raw: { status: 'AUTHENTICATED', name: 'ASHA RAO', yearOfBirth: '1994', documents: { AADHAAR: { status: 'SUCCESS', name: 'ASHA RAO', yearOfBirth: '1994', last4: '••••5647' }, PAN: { status: 'SUCCESS', name: 'ASHA RAO', last4: '••••234D', type: 'Individual' } } } });
    const kept = JSON.stringify(verified.raw);
    for (const never of ['xxxxxxxx5647', 'photo', 'xml', 'zip', '560001', '9876543210', 'S/O', 'ABCPV1234D', '15-08-1994']) expect(kept).not.toContain(never);

    const notLinked = await provider.refresh!(attempt, ctx(vi.fn(async (url: string) => (url.includes('/document/AADHAAR') ? reply(200, { status: 'AADHAAR_NOT_LINKED' }) : url.includes('/document/PAN') ? reply(400, { code: 'consent_not_granted' }) : reply(200, { status: 'AUTHENTICATED', document_requested: ['AADHAAR', 'PAN'], document_consent: ['AADHAAR'] })))));
    expect(notLinked).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'AADHAAR_NOT_LINKED' });

    const notReady = await provider.refresh!(attempt, ctx(vi.fn(async (url: string) => (url.includes('/document/') ? reply(202, { code: 'validation_pending' }) : reply(200, { status: 'AUTHENTICATED', document_requested: ['AADHAAR'] })))));
    expect(notReady.status).toBe('PENDING');

    // The photograph, read for the face match: in memory, with the consent's own codes when it has run out.
    const photo = await digilockerDocument('va0123456789abcdef0123456789abcd', 'AADHAAR', { keys: KEYS, fetchImpl: vi.fn(async () => reply(200, { status: 'SUCCESS', name: 'ASHA RAO', photo_link: Buffer.from('jpeg').toString('base64'), uid: 'xxxxxxxx5647' })) });
    expect(photo).toMatchObject({ ok: true, name: 'ASHA RAO', numberLast4: '••••5647' });
    expect((photo as { photo: Buffer }).photo.toString()).toBe('jpeg');
    expect(await digilockerDocument('va0123456789abcdef0123456789abcd', 'AADHAAR', { keys: KEYS, fetchImpl: vi.fn(async () => reply(400, { code: 'session_expired', message: 'Digilocker consent session expired' })) })).toMatchObject({ ok: false, pending: false, errorClass: 'BUSINESS', code: 'session_expired' });
  });

  it('UPI: the penny drop needs the holder’s consent; the reverse penny drop hands back the links and reads the status', async () => {
    const noConsent = await provider.run('UPI_VPA', { vpa: 'success@upi' }, ctx(vi.fn()));
    expect(noConsent).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'CONSENT_REQUIRED' });

    const drop = vi.fn(async () => reply(200, { verification_id: 'x', reference_id: 300, status: 'VALID', vpa: 'success@upi', name_at_bank: 'ASHA RAO', bank_account: '1234567890', ifsc: 'HDFC0000001', utr: 'UTR9', name_match_score: '100.00', name_match_result: 'MATCH' }));
    const dropped = await provider.run('UPI_VPA', { vpa: 'success@upi', name: 'Asha Rao', consent: { obtainedAt: new Date('2026-10-01T09:59:30Z'), purpose: 'Verifying the payout UPI id the account holder added' } }, ctx(drop));
    expect(sent(drop)).toEqual({ verification_id: 'va0123456789abcdef0123456789abcd', vpa: 'success@upi', user_consent: { obtained: true, type: 'EXPLICIT', timestamp: '2026-10-01T09:59:30Z', purpose: 'Verifying the payout UPI id the account holder added' }, name: 'Asha Rao' });
    expect(dropped).toMatchObject({ status: 'VERIFIED', matchedName: 'ASHA RAO', nameMatchScore: 100, raw: { mode: 'PENNY_DROP', vpa: 'su••••@upi', account: '••••7890' } });

    const reverseSettings = resolveVerificationSettings({ upiCheck: 'REVERSE_PENNY_DROP' });
    const create = vi.fn(async () => reply(200, { verification_id: 'x', ref_id: 301, valid_upto: '2026-10-01T10:10:00Z', upi_link: 'upi://pay?x', gpay: 'gpay://x', qr_code: 'base64png', url: 'https://hosted/x' }));
    const reverse = await provider.run('UPI_VPA', { vpa: 'asha@upi' }, { ...ctx(create), settings: reverseSettings });
    expect((create.mock.calls[0] as unknown as [string])[0]).toBe('https://sandbox.cashfree.com/verification/reverse-penny-drop');
    expect(reverse).toMatchObject({ status: 'NEEDS_USER_ACTION', providerRef: '301', userAction: { kind: 'REDIRECT', url: 'upi://pay?x' }, transient: { links: { upi_link: 'upi://pay?x', gpay: 'gpay://x' }, qrCode: 'base64png' } });
    expect(JSON.stringify(reverse.raw)).not.toContain('base64png');
    const status = vi.fn(async () => reply(200, { status: 'SUCCESS', name_at_bank: 'ASHA RAO', bank_account: '9876543210', ifsc: 'HDFC0000001', name_match_score: '100.00' }));
    const read = await provider.refresh!({ checkType: 'UPI_VPA', verificationId: 'va0123456789abcdef0123456789abcd', providerRef: '301', result: reverse.raw }, { ...ctx(status), settings: reverseSettings });
    expect((status.mock.calls[0] as unknown as [string])[0]).toBe('https://sandbox.cashfree.com/verification/remitter/status?verification_id=va0123456789abcdef0123456789abcd');
    expect(read).toMatchObject({ status: 'VERIFIED', matchedName: 'ASHA RAO', raw: { account: '••••3210' } });
  });

  it('a technical failure on the wire is the class on the result, a 404 on DigiLocker is NOT_ENABLED, and nothing throws', async () => {
    expect(await provider.run('DIGILOCKER', { documents: ['AADHAAR'] }, ctx(vi.fn(async () => reply(404, undefined))))).toMatchObject({ status: 'FAILED', errorClass: 'NOT_ENABLED' });
    expect(await provider.run('PAN', { pan: 'ABCPV1234D' }, ctx(vi.fn(async () => reply(403, { code: 'ip_validation_failed', message: 'IP not whitelisted your current ip is 1.2.3.4' }))))).toMatchObject({ status: 'FAILED', errorClass: 'AUTH_CONFIG', failureCode: 'ip_validation_failed' });
  });
});

describe('the Digio provider', () => {
  it('maps the client’s typed errors onto the classes and keeps the thrown error for the caller', async () => {
    const provider = verificationRuntime().providers.DIGIO;
    const ctx = { verificationId: 'v1', attemptNo: 1, caseType: 'PUBLISHER_KYC' as const, caseId: 'pub_1', settings: resolveVerificationSettings(null) };
    const outage = new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'down', { provider: 'DIGIO', reason: 'PROVIDER_ERROR' });
    (outage as { cause?: string }).cause = 'TIMEOUT';
    const cases: [ApiError, ErrorClass][] = [
      [outage, 'TIMEOUT'],
      [new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'down', { provider: 'DIGIO', reason: 'PROVIDER_ERROR' }), 'HTTP_5XX'],
      [new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'off', { provider: 'MANUAL', retryAfter: 3600 }), 'PROVIDER_SWITCHED_OFF'],
      [new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'degraded', { provider: 'DEGRADED', retryAfter: 300 }), 'PROVIDER_SWITCHED_OFF'],
      [new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'no keys', { provider: 'MANUAL' }), 'MOCK_IN_PRODUCTION'],
      [new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'no template', { provider: 'MANUAL', reason: 'NO_TEMPLATE' }), 'AUTH_CONFIG'],
      [new ApiError(502, 'KYC_PROVIDER_REFUSED', 'refused', { provider: 'DIGIO', status: 401, code: 'unauthorized' }), 'AUTH_CONFIG'],
      [new ApiError(502, 'KYC_PROVIDER_REFUSED', 'refused', { provider: 'DIGIO', status: 404, code: 'template_not_found' }), 'NOT_ENABLED'],
      [new ApiError(502, 'KYC_PROVIDER_REFUSED', 'refused', { provider: 'DIGIO', status: 400, code: 'bad_identifier' }), 'BUSINESS'],
    ];
    for (const [error, errorClass] of cases) {
      digio.requestDigioKyc.mockRejectedValueOnce(error);
      const result = await provider.run('HOSTED_KYC', { digio: DIGIO_REQUEST }, ctx);
      expect(result.status).toBe('FAILED');
      expect(result.errorClass).toBe(errorClass);
      expect((result.transient as { error: unknown }).error).toBe(error);
    }
    digio.requestDigioKyc.mockResolvedValueOnce(DIGIO_SESSION);
    const ok = await provider.run('HOSTED_KYC', { digio: DIGIO_REQUEST }, ctx);
    expect(ok).toMatchObject({ status: 'NEEDS_USER_ACTION', providerRef: 'KID1', userAction: { url: 'https://gw/#KID1' }, raw: { workflowKey: 'PUBLISHER.INDIVIDUAL', mock: false } });
    expect(JSON.stringify(ok.raw)).not.toContain('asha@example.in');
  });
});

describe('the hosted start', () => {
  const cashfreeReady = () => wireVerification({ providers: { CASHFREE_SECURE_ID: createSecureIdProvider(() => KEYS) } });
  const start = (over: Partial<Parameters<typeof startHostedKyc>[0]> = {}) =>
    startHostedKyc({ caseType: 'PUBLISHER_KYC', caseId: 'pub_1', digio: DIGIO_REQUEST, supports: ['CASHFREE'], origin: 'SELF', digioRequestOpen: false, ownerUserId: 'usr_1', subject: SUBJECT, ...over });
  const outage = () => {
    const error = new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'Digio is not answering right now; try again in a few minutes or upload your documents instead', { provider: 'DIGIO', reason: 'PROVIDER_ERROR' });
    (error as { cause?: string }).cause = 'TIMEOUT';
    return error;
  };

  it('Digio answering is the Digio session, recorded as an attempt, whatever the setting', async () => {
    const started = await start();
    expect(started).toEqual({ provider: 'DIGIO', session: DIGIO_SESSION });
    const [attempt] = await verificationRuntime().attempts.listForCase('PUBLISHER_KYC', 'pub_1');
    expect(attempt).toMatchObject({ checkType: 'HOSTED_KYC', provider: 'DIGIO', status: 'NEEDS_USER_ACTION', providerRef: 'KID1' });
  });

  it('with the backup OFF a Digio outage is exactly the 503 it always was — the attempt on record, no session, no flag', async () => {
    cashfreeReady();
    const error = outage();
    digio.requestDigioKyc.mockRejectedValueOnce(error);
    await expect(start()).rejects.toBe(error);
    const attempts = await verificationRuntime().attempts.listForCase('PUBLISHER_KYC', 'pub_1');
    expect(attempts.map((a) => [a.provider, a.errorClass])).toEqual([['DIGIO', 'TIMEOUT']]);
    expect(await verificationRuntime().sessions.findOpenForCase('PUBLISHER_KYC', 'pub_1')).toBeNull();
  });

  it('with the backup ON, the person’s own start from a client that supports Cashfree gets a Cashfree session of the workflow’s steps', async () => {
    cashfreeReady();
    wireVerification({ settings: async () => resolveVerificationSettings({ hostedKycBackup: 'ON' }) });
    digio.requestDigioKyc.mockRejectedValueOnce(outage());
    const started = await start();
    expect(started.provider).toBe('CASHFREE');
    if (started.provider !== 'CASHFREE') return;
    expect(started.session).toMatchObject({ caseType: 'PUBLISHER_KYC', caseId: 'pub_1', workflowKey: 'PUBLISHER.INDIVIDUAL', provider: 'CASHFREE_SECURE_ID', ownerUserId: 'usr_1', status: 'OPEN', subject: SUBJECT });
    expect(started.session.steps.map((s) => s.check)).toEqual(['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'BANK_ACCOUNT', 'NAME_MATCH']);
    const attempts = await verificationRuntime().attempts.listForCase('PUBLISHER_KYC', 'pub_1');
    expect(attempts.map((a) => [a.provider, a.status])).toEqual([
      ['CASHFREE_SECURE_ID', 'NEEDS_USER_ACTION'],
      ['DIGIO', 'FAILED'],
    ]);
    // A second start reuses the open session.
    digio.requestDigioKyc.mockRejectedValueOnce(outage());
    const again = await start();
    expect(again.provider === 'CASHFREE' && again.session.id).toBe(started.session.id);
  });

  it('a client that did not say it supports Cashfree gets the 503, and so does a Digio that said no (BUSINESS is final)', async () => {
    cashfreeReady();
    wireVerification({ settings: async () => resolveVerificationSettings({ hostedKycBackup: 'ON' }) });
    const error = outage();
    digio.requestDigioKyc.mockRejectedValueOnce(error);
    await expect(start({ supports: undefined })).rejects.toBe(error);
    const refused = new ApiError(502, 'KYC_PROVIDER_REFUSED', 'no', { provider: 'DIGIO', status: 400, code: 'bad' });
    digio.requestDigioKyc.mockRejectedValueOnce(refused);
    await expect(start()).rejects.toBe(refused);
    expect(await verificationRuntime().sessions.findOpenForCase('PUBLISHER_KYC', 'pub_1')).toBeNull();
  });

  it('the mid-flow rule: a Digio request already out is never switched silently — the 503 comes back flagged PROVIDER_FAILED; so does a desk start', async () => {
    cashfreeReady();
    wireVerification({ settings: async () => resolveVerificationSettings({ hostedKycBackup: 'ON' }) });
    digio.requestDigioKyc.mockRejectedValueOnce(outage());
    const midFlow = await start({ digioRequestOpen: true }).catch((err: unknown) => err);
    expect(midFlow).toBeInstanceOf(HostedKycProviderFailed);
    expect(midFlow).toMatchObject({ statusCode: 503, code: 'KYC_PROVIDER_UNAVAILABLE', providerFailed: true, details: { provider: 'DIGIO', reason: 'PROVIDER_ERROR', backup: { available: true, caseType: 'PUBLISHER_KYC', caseId: 'pub_1' } } });
    expect(await verificationRuntime().sessions.findOpenForCase('PUBLISHER_KYC', 'pub_1')).toBeNull();

    digio.requestDigioKyc.mockRejectedValueOnce(outage());
    const desk = await start({ origin: 'DESK', supports: undefined }).catch((err: unknown) => err);
    expect(desk).toBeInstanceOf(HostedKycProviderFailed);

    // Not flagged when Cashfree has no keys: there is no backup to send.
    wireVerification({ providers: { CASHFREE_SECURE_ID: createSecureIdProvider(() => ({ testMode: true })) } });
    const error = outage();
    digio.requestDigioKyc.mockRejectedValueOnce(error);
    await expect(start({ origin: 'DESK', supports: undefined })).rejects.toBe(error);
  });

  it('a Digio the breaker keeps from being asked answers the outage 503 — and the Cashfree session when it may', async () => {
    const settings = resolveVerificationSettings({ breaker: { failures: 1 } });
    wireVerification({ settings: async () => settings });
    digio.requestDigioKyc.mockRejectedValueOnce(outage());
    await expect(start()).rejects.toMatchObject({ statusCode: 503 });
    await expect(start()).rejects.toMatchObject({ statusCode: 503, code: 'KYC_PROVIDER_UNAVAILABLE', details: { provider: 'DIGIO', reason: 'PROVIDER_ERROR' } });
    expect(digio.requestDigioKyc).toHaveBeenCalledTimes(1);

    cashfreeReady();
    wireVerification({ settings: async () => resolveVerificationSettings({ breaker: { failures: 1 }, hostedKycBackup: 'ON' }) });
    expect((await start()).provider).toBe('CASHFREE');
  });
});

describe('the webhook', () => {
  const secret = 'cfsk_test_1';
  const body = JSON.stringify({ event_type: 'DIGILOCKER_VERIFICATION_SUCCESS', event_time: '2026-10-01T10:00:00Z', version: 'v1', data: { verification_id: 'va1', reference_id: 200, status: 'AUTHENTICATED' } });

  it('accepts Base64 HMAC-SHA256 of timestamp + raw body under the client secret, in milliseconds or seconds', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    const ms = String(now.getTime());
    expect(verifySecureIdWebhook({ rawBody: Buffer.from(body), signature: secureIdWebhookSignature(ms, body, secret), timestamp: ms, secret, now })).toEqual({ ok: true });
    const seconds = String(Math.floor(now.getTime() / 1000));
    expect(verifySecureIdWebhook({ rawBody: body, signature: secureIdWebhookSignature(seconds, body, secret), timestamp: seconds, secret, now })).toEqual({ ok: true });
  });

  it('refuses no secret, missing headers, a wrong signature, a re-serialised body and a stale timestamp', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    const ts = String(now.getTime());
    const good = secureIdWebhookSignature(ts, body, secret);
    expect(verifySecureIdWebhook({ rawBody: body, signature: good, timestamp: ts, secret: undefined, now })).toEqual({ ok: false, reason: 'NO_SECRET' });
    expect(verifySecureIdWebhook({ rawBody: body, signature: undefined, timestamp: ts, secret, now })).toEqual({ ok: false, reason: 'MISSING_HEADERS' });
    expect(verifySecureIdWebhook({ rawBody: body, signature: good, timestamp: 'yesterday', secret, now })).toEqual({ ok: false, reason: 'MISSING_HEADERS' });
    expect(verifySecureIdWebhook({ rawBody: body, signature: secureIdWebhookSignature(ts, body, 'other'), timestamp: ts, secret, now })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verifySecureIdWebhook({ rawBody: JSON.stringify(JSON.parse(body), null, 2), signature: good, timestamp: ts, secret, now })).toEqual({ ok: false, reason: 'MISMATCH' });
    const old = String(now.getTime() - 6 * 60_000);
    expect(verifySecureIdWebhook({ rawBody: body, signature: secureIdWebhookSignature(old, body, secret), timestamp: old, secret, now })).toEqual({ ok: false, reason: 'STALE' });
    const future = String(now.getTime() + 6 * 60_000);
    expect(verifySecureIdWebhook({ rawBody: body, signature: secureIdWebhookSignature(future, body, secret), timestamp: future, secret, now })).toEqual({ ok: false, reason: 'STALE' });
  });

  it('reads the event and its de-duplication key; the same event claims once', async () => {
    const event = parseSecureIdEvent(JSON.parse(body));
    expect(event).toMatchObject({ eventType: 'DIGILOCKER_VERIFICATION_SUCCESS', eventId: 'DIGILOCKER_VERIFICATION_SUCCESS:va1' });
    expect(parseSecureIdEvent({ event_type: 'BANK_ACCOUNT_VERIFICATION_SUCCESS', data: { reference_id: 58, user_id: 'va2' } })?.eventId).toBe('BANK_ACCOUNT_VERIFICATION_SUCCESS:va2');
    expect(parseSecureIdEvent({ hello: 'world' })).toBeNull();
    expect(parseSecureIdEvent({ event_type: 'X', data: {} })).toBeNull();
    const events = verificationRuntime().events;
    expect((await events.claim('CASHFREE_SECURE_ID', event!.eventId, event!.eventType)).fresh).toBe(true);
    expect((await events.claim('CASHFREE_SECURE_ID', event!.eventId, event!.eventType)).fresh).toBe(false);
  });
});

describe('the attempt read-back', () => {
  it('reads a pending attempt through its provider and records where it got to; a final one is left alone', async () => {
    const provider = { ...scripted('CASHFREE_SECURE_ID', [{ status: 'NEEDS_USER_ACTION' }]), refresh: vi.fn(async (attempt: { verificationId: string }) => ({ status: 'VERIFIED' as const, provider: 'CASHFREE_SECURE_ID' as const, providerRef: '200', verificationId: attempt.verificationId, raw: { status: 'AUTHENTICATED' } })) };
    wireVerification({ providers: { CASHFREE_SECURE_ID: provider } });
    const routed = await runCheck('DIGILOCKER', { documents: ['AADHAAR'] }, CASE);
    const read = await refreshAttempt(routed.attemptId!);
    expect(read?.attempt).toMatchObject({ status: 'VERIFIED', providerRef: '200', result: { status: 'AUTHENTICATED' } });
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    const again = await refreshAttempt(routed.attemptId!);
    expect(again?.result).toBeNull();
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(await refreshAttempt('nope')).toBeNull();
  });
});

describe('the legacy wrappers', () => {
  it('still answer the old shape, over the documented calls', async () => {
    const rc = await lookupVehicleRc('ka 01 ab-1234', vi.fn(async () => reply(200, { reference_id: 'ref_1', status: 'VALID', reg_no: 'KA01AB1234', owner: 'DEEPAK RAO' })), KEYS);
    expect(rc).toMatchObject({ ok: true, facts: { registrationNumber: 'KA01AB1234', ownerName: 'DEEPAK RAO', status: 'VALID', referenceId: 'ref_1' } });
    expect(await lookupVehicleRc('KA01AB1234', vi.fn(async () => reply(403, { message: 'IP not whitelisted' })), KEYS)).toEqual({ ok: false, code: 'REFUSED', status: 403, message: 'IP not whitelisted' });
    expect(await lookupVehicleRc('KA01AB1234', vi.fn(), { testMode: true })).toMatchObject({ ok: false, code: 'UNCONFIGURED' });
    const bank = await verifyBankAccount({ accountNumber: '1234567890', ifsc: 'HDFC0001234', name: 'Deepak Rao' }, vi.fn(async () => reply(200, { reference_id: 'b_1', account_status: 'VALID', name_at_bank: 'DEEPAK RAO', name_match_score: '92.5' })), KEYS);
    expect(bank).toMatchObject({ ok: true, facts: { valid: true, nameAtBank: 'DEEPAK RAO', nameMatchScore: 92.5, referenceId: 'b_1' } });
  });
});
