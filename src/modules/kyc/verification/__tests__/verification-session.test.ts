import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cashfree Phase 1 (the owner, 1 Oct 2026) — the Cashfree session on ADX's
 * own screens, and the desk beside it.
 *
 * Pinned, with nothing leaving the process (fetch is stubbed; the stores
 * are memory): a session is the person's own and nobody else's; DigiLocker
 * opens a page, is read back, and keeps the name and the last four and
 * never the number; the selfie is matched to the DigiLocker photograph
 * fetched again in memory, and when the consent has run out DigiLocker is
 * asked again; the bank account and the holder's name; the business PAN
 * and GSTIN; an individual whose every step passes is VERIFIED through the
 * hosted-decision road, a business goes to the desk IN_REVIEW; the desk's
 * attempt list, health read and "Resend on backup"; Cashfree's webhook —
 * signed, fresh, handled once, 200 at once; and the sweep.
 */

const KEYS = { clientId: 'CF10001', clientSecret: 'cfsk_test_1', testMode: true };
const ports = vi.hoisted(() => ({
  audit: { logActivity: vi.fn(), auditDiff: vi.fn() },
  notifications: { createNotification: vi.fn() },
  config: { getEffectiveSecureIdConfig: vi.fn(async () => ({ clientId: 'CF10001', clientSecret: 'cfsk_test_1', publicKey: undefined, testMode: true })) },
}));

vi.mock('../../../../shared/audit', () => ports.audit);
vi.mock('../../../notifications', () => ports.notifications);
vi.mock('../../../../shared/integrations/integration-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/integrations/integration-config')>()),
  getEffectiveSecureIdConfig: ports.config.getEffectiveSecureIdConfig,
}));

import { errorHandler } from '../../../../shared/errors';
import { tokenFor } from '../../../../shared/testing';
import {
  createSecureIdProvider,
  hostedKycBackupReady,
  kycAvailabilityWithBackup,
  openCashfreeSession,
  resetVerificationRuntime,
  resolveVerificationSettings,
  secureIdWebhookSignature,
  verificationRuntime,
  wireVerification,
  type SessionRecord,
} from '../../../../shared/verification';
import { secureIdWebhookRouter, verificationRouter } from '../verification.routes';
import { secureIdWebhookSettled } from '../verification.controller';
import { registerBackupCase, registerHostedOutcomeHandler, resetVerificationPorts, sweepVerification } from '../verification.service';

function app() {
  const instance = express();
  instance.use(express.json({ verify: (req, _res, buf) => void ((req as express.Request).rawBody = buf) }));
  const api = Router();
  api.use('/verification', verificationRouter);
  api.use('/webhooks/cashfree/verification', secureIdWebhookRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const owner = tokenFor(['PUBLISHER'], 'usr_1');
const stranger = tokenFor(['PUBLISHER'], 'usr_2');
const admin = tokenFor(['ADMIN'], 'adm_1');
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }) as unknown as Response;

/** Cashfree, scripted by path. */
type Script = Record<string, (url: string, init: RequestInit) => Response | Promise<Response>>;
function cashfree(script: Script) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace('https://sandbox.cashfree.com/verification', '').split('?')[0]!;
    const handler = script[`${init.method} ${path}`] ?? script[path];
    if (!handler) throw new Error(`No script for ${init.method} ${path}`);
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

const AADHAAR_DOC = { reference_id: 200, status: 'SUCCESS', uid: 'xxxxxxxx5647', name: 'ASHA RAO', dob: '15-08-1994', year_of_birth: '1994', photo_link: Buffer.from('reference-jpeg').toString('base64'), xml_file: 'https://zip' };
const PAN_DOC = { reference_id: 200, status: 'SUCCESS', pan: 'ABCPV1234D', type: 'Individual', name_pan_card: 'ASHA RAO' };
const AUTHENTICATED = { user_details: { name: 'ASHA RAO', dob: '15-08-1994', eaadhaar: 'Y', mobile: '9876543210' }, status: 'AUTHENTICATED', document_requested: ['AADHAAR', 'PAN'], document_consent: ['AADHAAR', 'PAN'], verification_id: 'x', reference_id: 200 };
const digilockerScript: Script = {
  '/digilocker': () => reply(200, { verification_id: 'x', reference_id: 200, url: 'https://verification-test.cashfree.com/dgl/abc', status: 'PENDING' }),
  'GET /digilocker': () => reply(200, AUTHENTICATED),
  '/digilocker/document/AADHAAR': () => reply(200, AADHAAR_DOC),
  '/digilocker/document/PAN': () => reply(200, PAN_DOC),
};
const faceScript: Script = {
  '/face-liveness': () => reply(200, { reference_id: 300, status: 'SUCCESS', liveness: true, liveness_score: 0.97 }),
  '/face-match': () => reply(200, { status: 'SUCCESS', ref_id: 301, face_match_result: 'YES', face_match_score: 0.9 }),
};
const bankScript: Script = {
  '/bank-account/sync': () => reply(200, { reference_id: 400, name_at_bank: 'ASHA RAO', bank_name: 'HDFC Bank', account_status: 'VALID', account_status_code: 'ACCOUNT_IS_VALID' }),
  '/name-match': () => reply(200, { reference_id: 401, status: 'SUCCESS', score: 0.95, reason: 'GOOD_PARTIAL_MATCH' }),
};

const outcome = vi.fn(async () => true);
let session: SessionRecord;

async function open(workflowKey = 'PUBLISHER.INDIVIDUAL', business = false, caseId = 'pub_1'): Promise<SessionRecord> {
  return openCashfreeSession({ caseType: 'PUBLISHER_KYC', caseId, workflowKey, ownerUserId: 'usr_1', subject: { name: 'Asha Rao', party: 'PUBLISHER', business } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetVerificationRuntime();
  resetVerificationPorts();
  wireVerification({ providers: { CASHFREE_SECURE_ID: createSecureIdProvider(() => KEYS) }, settings: async () => resolveVerificationSettings({ hostedKycBackup: 'ON' }) });
  registerHostedOutcomeHandler(outcome);
  session = await open();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the session is the person’s own', () => {
  it('the owner reads it; a stranger and an admin are told it does not exist', async () => {
    const mine = await request(app()).get(`/api/v1/verification/sessions/${session.id}`).set(as(owner));
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ id: session.id, provider: 'CASHFREE', status: 'OPEN', workflowKey: 'PUBLISHER.INDIVIDUAL' });
    expect(mine.body.data.steps.map((s: { check: string; status: string; triesLeft: number }) => [s.check, s.status, s.triesLeft])).toEqual([
      ['DIGILOCKER', 'OPEN', 3],
      ['FACE_LIVENESS', 'OPEN', 3],
      ['FACE_MATCH', 'OPEN', 3],
      ['BANK_ACCOUNT', 'OPEN', 3],
      ['NAME_MATCH', 'OPEN', 3],
    ]);
    expect(mine.body.data).not.toHaveProperty('subject');
    expect((await request(app()).get(`/api/v1/verification/sessions/${session.id}`).set(as(stranger))).status).toBe(404);
    expect((await request(app()).get(`/api/v1/verification/sessions/${session.id}`).set(as(admin))).status).toBe(404);
    expect((await request(app()).get(`/api/v1/verification/sessions/${session.id}`)).status).toBe(401);
  });

  it('a session past its time reads EXPIRED and takes no step', async () => {
    await verificationRuntime().sessions.update(session.id, {});
    const row = verificationRuntime().sessions as unknown as { rows: SessionRecord[] };
    row.rows[0]!.expiresAt = new Date(Date.now() - 1000);
    const read = await request(app()).get(`/api/v1/verification/sessions/${session.id}`).set(as(owner));
    expect(read.body.data.status).toBe('EXPIRED');
    expect(outcome).toHaveBeenCalledWith({ id: `cf_${session.id}`, status: 'expired' });
    const step = await request(app()).post(`/api/v1/verification/sessions/${session.id}/bank`).set(as(owner)).send({ accountNumber: '1234567890', ifsc: 'HDFC0001234' });
    expect(step.status).toBe(409);
    expect(step.body.error.code).toBe('VERIFICATION_SESSION_CLOSED');
  });
  it('the owner finds their open sessions at /sessions/mine — never a stranger’s, never a closed or overdue one', async () => {
    const mine = await request(app()).get('/api/v1/verification/sessions/mine').set(as(owner));
    expect(mine.status).toBe(200);
    expect(mine.body.data.sessions.map((s: { id: string }) => s.id)).toEqual([session.id]);
    expect(mine.body.data.sessions[0]).not.toHaveProperty('subject');
    expect((await request(app()).get('/api/v1/verification/sessions/mine').set(as(stranger))).body.data.sessions).toEqual([]);
    const row = verificationRuntime().sessions as unknown as { rows: SessionRecord[] };
    row.rows[0]!.expiresAt = new Date(Date.now() - 1000);
    expect((await request(app()).get('/api/v1/verification/sessions/mine').set(as(owner))).body.data.sessions).toEqual([]);
    expect(outcome).toHaveBeenCalledWith({ id: `cf_${session.id}`, status: 'expired' });
    expect((await request(app()).get('/api/v1/verification/sessions/mine')).status).toBe(401);
  });
});

describe('whether the backup is ready (what the availability reads carry)', () => {
  it('is ready with the switch ON and keys in; not with the switch OFF, nor without keys', async () => {
    expect(await hostedKycBackupReady()).toBe(true);
    expect(await kycAvailabilityWithBackup({ available: false, provider: 'MANUAL', retryAfter: 3600 })).toEqual({ available: false, provider: 'MANUAL', retryAfter: 3600, backup: true });
    resetVerificationRuntime();
    wireVerification({ providers: { CASHFREE_SECURE_ID: createSecureIdProvider(() => KEYS) }, settings: async () => resolveVerificationSettings({ hostedKycBackup: 'OFF' }) });
    expect(await hostedKycBackupReady()).toBe(false);
    resetVerificationRuntime();
    wireVerification({ providers: { CASHFREE_SECURE_ID: createSecureIdProvider(() => ({ clientId: '', clientSecret: '', testMode: true })) }, settings: async () => resolveVerificationSettings({ hostedKycBackup: 'ON' }) });
    expect(await hostedKycBackupReady()).toBe(false);
  });

  it('reads as no backup when the settings cannot be read — never a failed page', async () => {
    resetVerificationRuntime();
    wireVerification({ providers: { CASHFREE_SECURE_ID: createSecureIdProvider(() => KEYS) }, settings: async () => { throw new Error('db down'); } });
    expect(await kycAvailabilityWithBackup({ available: true })).toEqual({ available: true, backup: false });
  });
});

describe('a bad field', () => {
  it('answers 400 with the field’s own sentence as the message, the field list in the details', async () => {
    const res = await request(app()).post(`/api/v1/verification/sessions/${session.id}/bank`).set(as(owner)).send({ accountNumber: '1234567890', ifsc: 'HDFC1234' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('An IFSC is 4 letters, a zero and 6 characters');
    expect(res.body.error.details.fieldErrors.ifsc).toEqual(['An IFSC is 4 letters, a zero and 6 characters']);
  });
});

describe('DigiLocker', () => {
  it('opens the page for an https address only, reads the consent back, keeps the name and the last four — never the number', async () => {
    const fetchImpl = cashfree(digilockerScript);
    const bad = await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker`).set(as(owner)).send({ redirectUrl: 'http://adx.in/back' });
    expect(bad.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();

    const started = await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker`).set(as(owner)).send({ redirectUrl: 'https://adx.in/verify/back' });
    expect(started.status).toBe(200);
    expect(started.body.data.url).toBe('https://verification-test.cashfree.com/dgl/abc');
    expect(started.body.data.session.status).toBe('NEEDS_USER_ACTION');
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ document_requested: ['AADHAAR', 'PAN'], redirect_url: 'https://adx.in/verify/back' });

    const refreshed = await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker/refresh`).set(as(owner));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data).toMatchObject({ status: 'VERIFIED', name: 'ASHA RAO', documents: { AADHAAR: { status: 'SUCCESS', last4: '••••5647' }, PAN: { status: 'SUCCESS', last4: '••••234D' } } });
    expect(refreshed.body.data.session.steps[0]).toMatchObject({ check: 'DIGILOCKER', status: 'VERIFIED' });
    expect(JSON.stringify(refreshed.body)).not.toContain('xxxxxxxx5647');

    const [attempt] = await verificationRuntime().attempts.listForCase('PUBLISHER_KYC', 'pub_1');
    expect(attempt).toMatchObject({ checkType: 'DIGILOCKER', sessionId: session.id, status: 'VERIFIED' });
    const kept = JSON.stringify(attempt);
    for (const never of ['xxxxxxxx5647', 'reference-jpeg', 'https://zip', '9876543210', 'ABCPV1234D']) expect(kept).not.toContain(never);
    const saved = await verificationRuntime().sessions.find(session.id);
    expect(saved?.subject?.identityName).toBe('ASHA RAO');
  });

  it('a denied consent is a "no" the person may try again; refreshing before opening is refused', async () => {
    cashfree({ ...digilockerScript, 'GET /digilocker': () => reply(200, { status: 'CONSENT_DENIED', verification_id: 'x', reference_id: 200 }) });
    expect((await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker/refresh`).set(as(owner))).status).toBe(409);
    await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker`).set(as(owner)).send({ redirectUrl: 'https://adx.in/back' });
    const refreshed = await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker/refresh`).set(as(owner));
    expect(refreshed.body.data).toMatchObject({ status: 'FAILED', failureCode: 'CONSENT_DENIED' });
    expect(refreshed.body.data.session.steps[0]).toMatchObject({ status: 'FAILED', triesLeft: 2 });
    expect(refreshed.body.data.session.status).toBe('OPEN');
  });
});

async function throughDigilocker(): Promise<void> {
  await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker`).set(as(owner)).send({ redirectUrl: 'https://adx.in/back' });
  await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker/refresh`).set(as(owner));
}

describe('the selfie', () => {
  it('needs DigiLocker first; then liveness and the match against the DigiLocker photograph fetched again in memory — nothing stored', async () => {
    const fetchImpl = cashfree({ ...digilockerScript, ...faceScript });
    const early = await request(app()).post(`/api/v1/verification/sessions/${session.id}/selfie`).set(as(owner)).attach('file', Buffer.from('selfie-jpeg'), { filename: 'selfie.jpg', contentType: 'image/jpeg' });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'VERIFICATION_STEP_NOT_OPEN', details: { needs: 'DIGILOCKER' } });

    await throughDigilocker();
    const res = await request(app()).post(`/api/v1/verification/sessions/${session.id}/selfie`).set(as(owner)).attach('file', Buffer.from('selfie-jpeg'), { filename: 'selfie.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ liveness: { status: 'VERIFIED', score: 0.97 }, faceMatch: { status: 'VERIFIED', score: 0.9 } });
    expect(res.body.data.session.steps.map((s: { check: string; status: string }) => s.status)).toEqual(['VERIFIED', 'VERIFIED', 'VERIFIED', 'OPEN', 'OPEN']);

    const calls = fetchImpl.mock.calls.map((call) => (call as unknown as [string, { method: string }])[0].replace('https://sandbox.cashfree.com/verification', '').split('?')[0]);
    expect(calls.slice(-3)).toEqual(['/face-liveness', '/digilocker/document/AADHAAR', '/face-match']);
    const matchForm = (fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [string, { body: FormData }])[1].body;
    expect(await (matchForm.get('first_image') as Blob).text()).toBe('selfie-jpeg');
    expect(await (matchForm.get('second_image') as Blob).text()).toBe('reference-jpeg');

    const attempts = await verificationRuntime().attempts.listForCase('PUBLISHER_KYC', 'pub_1');
    expect(attempts.map((a) => [a.checkType, a.status])).toEqual([['FACE_MATCH', 'VERIFIED'], ['FACE_LIVENESS', 'VERIFIED'], ['DIGILOCKER', 'VERIFIED']]);
    expect(JSON.stringify(attempts)).not.toContain('selfie-jpeg');
    expect(JSON.stringify(attempts)).not.toContain('reference-jpeg');
  });

  it('a picture that is not a live face is a "no" with a try spent; a non-image is refused before any call', async () => {
    const fetchImpl = cashfree({ ...digilockerScript, '/face-liveness': () => reply(200, { status: 'FACE_NOT_DETECTED', liveness: false, liveness_score: 0 }) });
    await throughDigilocker();
    const bad = await request(app()).post(`/api/v1/verification/sessions/${session.id}/selfie`).set(as(owner)).attach('file', Buffer.from('%PDF-'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_IMAGE');
    const res = await request(app()).post(`/api/v1/verification/sessions/${session.id}/selfie`).set(as(owner)).attach('file', Buffer.from('blur'), { filename: 'selfie.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ liveness: { status: 'FAILED', failureCode: 'FACE_NOT_DETECTED' }, faceMatch: null });
    expect(res.body.data.session.steps[1]).toMatchObject({ check: 'FACE_LIVENESS', status: 'FAILED', triesLeft: 2 });
    expect(fetchImpl.mock.calls.some((call) => (call as unknown as [string])[0].includes('/face-match'))).toBe(false);
  });

  it('when the DigiLocker consent has run out, DigiLocker is asked again and the liveness that passed stands', async () => {
    cashfree({ ...digilockerScript, ...faceScript, '/digilocker/document/AADHAAR': () => reply(400, { code: 'session_expired', message: 'Digilocker consent session expired' }) });
    // The status read already happened on a fresh consent; only the later document read is expired.
    const fresh = cashfree({ ...digilockerScript, ...faceScript });
    await throughDigilocker();
    cashfree({ ...digilockerScript, ...faceScript, '/digilocker/document/AADHAAR': () => reply(400, { code: 'session_expired', message: 'Digilocker consent session expired' }) });
    expect(fresh).toBeDefined();
    const res = await request(app()).post(`/api/v1/verification/sessions/${session.id}/selfie`).set(as(owner)).attach('file', Buffer.from('selfie-jpeg'), { filename: 'selfie.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'DIGILOCKER_CONSENT_REQUIRED', details: { needs: 'DIGILOCKER' } });
    const saved = await verificationRuntime().sessions.find(session.id);
    expect(saved?.steps.map((s) => [s.check, s.status])).toEqual([['DIGILOCKER', 'OPEN'], ['FACE_LIVENESS', 'VERIFIED'], ['FACE_MATCH', 'OPEN'], ['BANK_ACCOUNT', 'OPEN'], ['NAME_MATCH', 'OPEN']]);
  });
});

describe('the bank account', () => {
  it('needs the identity first; then the account and its holder matched to the DigiLocker name — and an individual passing everything is VERIFIED down the hosted-decision road', async () => {
    cashfree({ ...digilockerScript, ...faceScript, ...bankScript });
    const early = await request(app()).post(`/api/v1/verification/sessions/${session.id}/bank`).set(as(owner)).send({ accountNumber: '1234567890', ifsc: 'HDFC0001234' });
    expect(early.status).toBe(409);
    expect(early.body.error.details).toMatchObject({ needs: 'DIGILOCKER' });

    await throughDigilocker();
    await request(app()).post(`/api/v1/verification/sessions/${session.id}/selfie`).set(as(owner)).attach('file', Buffer.from('selfie-jpeg'), { filename: 'selfie.jpg', contentType: 'image/jpeg' });
    expect(outcome).not.toHaveBeenCalled();

    const res = await request(app()).post(`/api/v1/verification/sessions/${session.id}/bank`).set(as(owner)).send({ accountNumber: '1234 5678 90', ifsc: 'hdfc0001234' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ bank: { status: 'VERIFIED', bankName: 'HDFC Bank' }, nameMatch: { status: 'VERIFIED', score: 95 } });
    expect(res.body.data.session.status).toBe('VERIFIED');
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(outcome).toHaveBeenCalledWith({ id: `cf_${session.id}`, status: 'approved', completed_at: expect.any(String) });

    const attempts = await verificationRuntime().attempts.listForCase('PUBLISHER_KYC', 'pub_1');
    const bank = attempts.find((a) => a.checkType === 'BANK_ACCOUNT');
    expect(bank?.result).toMatchObject({ account: '••••7890', ifscCode: 'HDFC0001234', nameAtBank: 'ASHA RAO' });
    expect(JSON.stringify(bank)).not.toContain('1234567890');
    expect(attempts.find((a) => a.checkType === 'NAME_MATCH')?.nameMatchScore).toBe(95);
    // The session is closed now.
    const again = await request(app()).post(`/api/v1/verification/sessions/${session.id}/bank`).set(as(owner)).send({ accountNumber: '1234567890', ifsc: 'HDFC0001234' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('VERIFICATION_SESSION_CLOSED');
  });

  it('a name that does not agree is a "no" on the name step, the account step still passed', async () => {
    cashfree({ ...digilockerScript, ...bankScript, '/name-match': () => reply(200, { status: 'SUCCESS', score: 0.4, reason: 'POOR_PARTIAL_MATCH' }) });
    await throughDigilocker();
    const res = await request(app()).post(`/api/v1/verification/sessions/${session.id}/bank`).set(as(owner)).send({ accountNumber: '1234567890', ifsc: 'HDFC0001234' });
    expect(res.body.data).toMatchObject({ bank: { status: 'VERIFIED' }, nameMatch: { status: 'FAILED', failureCode: 'NAME_MISMATCH', score: 40 } });
    expect(res.body.data.session.steps.map((s: { check: string; status: string }) => [s.check, s.status])).toContainEqual(['NAME_MATCH', 'FAILED']);
  });

  it('Cashfree not answering is a 503 that holds nothing against the person', async () => {
    cashfree({ ...digilockerScript, '/bank-account/sync': () => reply(503, { code: 'request_failed' }) });
    await throughDigilocker();
    const res = await request(app()).post(`/api/v1/verification/sessions/${session.id}/bank`).set(as(owner)).send({ accountNumber: '1234567890', ifsc: 'HDFC0001234' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'VERIFICATION_UNAVAILABLE', details: { check: 'BANK_ACCOUNT', errorClass: 'HTTP_5XX' } });
    const saved = await verificationRuntime().sessions.find(session.id);
    expect(saved?.steps.find((s) => s.check === 'BANK_ACCOUNT')).toMatchObject({ status: 'OPEN', tries: 0 });
  });
});

describe('a business', () => {
  it('verifies the entity PAN and GSTIN, matches the bank to the registered name, and goes to the desk IN_REVIEW with the papers', async () => {
    session = await open('PUBLISHER.COMPANY', true, 'pub_biz');
    cashfree({
      ...digilockerScript,
      ...faceScript,
      ...bankScript,
      '/pan': () => reply(200, { pan: 'ABCCD8000T', type: 'Company', reference_id: 500, valid: true, registered_name: 'ASTER HOMES PRIVATE LIMITED', name_match_score: '90.00', pan_status: 'VALID' }),
      '/gstin': () => reply(200, { reference_id: 501, GSTIN: '29AAICP2912R1ZR', legal_name_of_business: 'ASTER HOMES PRIVATE LIMITED', valid: true, message: 'GSTIN Exists' }),
    });
    const bankEarly = await request(app()).post(`/api/v1/verification/sessions/${session.id}/business`).set(as(owner)).send({ pan: 'abccd8000t' });
    expect(bankEarly.status).toBe(200);
    expect(bankEarly.body.data).toMatchObject({ pan: { status: 'VERIFIED', registeredName: 'ASTER HOMES PRIVATE LIMITED', score: 90 }, gstin: null });

    const withGst = await request(app()).post(`/api/v1/verification/sessions/${session.id}/business`).set(as(owner)).send({ pan: 'ABCCD8000T', gstin: '29aaicp2912r1zr' });
    expect(withGst.body.data.gstin).toMatchObject({ status: 'VERIFIED', legalName: 'ASTER HOMES PRIVATE LIMITED' });

    await throughDigilocker();
    await request(app()).post(`/api/v1/verification/sessions/${session.id}/selfie`).set(as(owner)).attach('file', Buffer.from('selfie-jpeg'), { filename: 'selfie.jpg', contentType: 'image/jpeg' });
    const bank = await request(app()).post(`/api/v1/verification/sessions/${session.id}/bank`).set(as(owner)).send({ accountNumber: '1234567890', ifsc: 'HDFC0001234' });
    expect(bank.body.data.session.status).toBe('IN_REVIEW');
    expect(bank.body.data.session.steps.find((s: { check: string }) => s.check === 'PAPERS')).toMatchObject({ status: 'REVIEW' });
    expect(outcome).toHaveBeenCalledWith({ id: `cf_${session.id}`, status: 'in_review' });
    // The entity name is what the holder was matched against.
    const nameSent = JSON.parse(((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) => (call as unknown as [string])[0].endsWith('/name-match')) as unknown as [string, { body: string }])[1].body) as { name_2: string };
    expect(nameSent.name_2).toBe('ASTER HOMES PRIVATE LIMITED');
  });

  it('a print partner must give a GSTIN', async () => {
    session = await open('PRINT_PARTNER.COMPANY', true, 'pub_pp');
    const res = await request(app()).post(`/api/v1/verification/sessions/${session.id}/business`).set(as(owner)).send({ pan: 'ABCCD8000T' });
    expect(res.status).toBe(400);
  });
});

describe('an agent', () => {
  it('adds the driving licence and the vehicle', async () => {
    session = await openCashfreeSession({ caseType: 'AGENT_KYC', caseId: 'agt_1', workflowKey: 'AGENT', ownerUserId: 'usr_1', subject: { name: 'Rahul Menon', party: 'AGENT', business: false } });
    cashfree({
      '/driving-license': () => reply(200, { reference_id: 600, status: 'VALID', details_of_driving_licence: { name: 'RAHUL MENON' } }),
      '/vehicle-rc': () => reply(200, { reference_id: 601, status: 'VALID', reg_no: 'KA01AB1234', owner: 'RAHUL MENON' }),
    });
    const dl = await request(app()).post(`/api/v1/verification/sessions/${session.id}/driving-licence`).set(as(owner)).send({ dlNumber: 'KA0120198900984', dob: '1994-08-05' });
    expect(dl.body.data.drivingLicence).toMatchObject({ status: 'VERIFIED' });
    const rc = await request(app()).post(`/api/v1/verification/sessions/${session.id}/vehicle`).set(as(owner)).send({ vehicleNumber: 'ka 01 ab 1234' });
    expect(rc.body.data.vehicle).toMatchObject({ status: 'VERIFIED' });
    expect((await request(app()).post(`/api/v1/verification/sessions/${session.id}/vehicle`).set(as(owner)).send({ vehicleNumber: 'nope' })).status).toBe(400);
    // Not a step of a publisher's session.
    const other = await open('PUBLISHER.INDIVIDUAL', false, 'pub_other');
    const refused = await request(app()).post(`/api/v1/verification/sessions/${other.id}/vehicle`).set(as(owner)).send({ vehicleNumber: 'KA01AB1234' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('VERIFICATION_STEP_NOT_OPEN');
  });
});

describe('the desk', () => {
  it('lists a case’s attempts and sessions (kyc.view), and says whether the backup can be sent', async () => {
    registerBackupCase('PUBLISHER_KYC', { load: async () => ({ ownerUserId: 'usr_1', subject: { name: 'Asha Rao', party: 'PUBLISHER', business: false }, workflowKey: 'PUBLISHER.INDIVIDUAL', verified: false }), stamp: vi.fn() });
    cashfree(digilockerScript);
    await throughDigilocker();
    const res = await request(app()).get('/api/v1/verification/attempts').query({ caseType: 'publisher_kyc', caseId: 'pub_1' }).set(as(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.attempts).toHaveLength(1);
    expect(res.body.data.attempts[0]).toMatchObject({ checkType: 'DIGILOCKER', provider: 'CASHFREE_SECURE_ID', providerLabel: 'Cashfree Secure ID', status: 'VERIFIED', verificationId: expect.any(String) });
    expect(res.body.data.sessions[0]).toMatchObject({ id: session.id, status: 'OPEN' });
    expect(res.body.data.backup).toEqual({ setting: 'ON', available: true });
    expect((await request(app()).get('/api/v1/verification/attempts').query({ caseType: 'PUBLISHER_KYC', caseId: 'pub_1' }).set(as(owner))).status).toBe(403);
    expect((await request(app()).get('/api/v1/verification/attempts').query({ caseType: 'NOPE', caseId: 'pub_1' }).set(as(admin))).status).toBe(400);
  });

  it('"Resend on backup" opens the party’s session, puts their record on the Cashfree path, tells them, and is audited; refused when switched off, verified or unknown', async () => {
    const stamp = vi.fn();
    registerBackupCase('ADVERTISER_KYC', {
      load: async (caseId) => (caseId === 'adv_1' ? { ownerUserId: 'usr_adv', subject: { name: 'Meera S', party: 'ADVERTISER', business: false }, workflowKey: 'ADVERTISER.INDIVIDUAL', verified: false } : caseId === 'adv_done' ? { ownerUserId: 'usr_x', subject: { name: 'X', party: 'ADVERTISER', business: false }, workflowKey: 'ADVERTISER.INDIVIDUAL', verified: true } : null),
      stamp,
    });
    const res = await request(app()).post('/api/v1/verification/cases/ADVERTISER_KYC/adv_1/resend-on-backup').set(as(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.session).toMatchObject({ provider: 'CASHFREE', caseType: 'ADVERTISER_KYC', caseId: 'adv_1', workflowKey: 'ADVERTISER.INDIVIDUAL', status: 'OPEN' });
    expect(res.body.data.notified).toBe(true);
    const sessionId = res.body.data.session.id as string;
    expect(stamp).toHaveBeenCalledWith('adv_1', { method: 'CASHFREE', digioRequestId: `cf_${sessionId}`, digioReferenceId: `backup-${sessionId}`, digioStatus: 'pending', at: expect.any(Date) });
    expect(ports.notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', type: 'KYC', relatedId: sessionId, relatedType: 'VERIFICATION_SESSION' }));
    expect(ports.audit.logActivity).toHaveBeenCalledWith('adm_1', 'KYC_RESENT_ON_BACKUP', expect.objectContaining({ targetType: 'ADVERTISER_KYC', targetId: 'adv_1', metadata: expect.objectContaining({ sessionId, provider: 'CASHFREE_SECURE_ID' }) }));
    const attempts = await verificationRuntime().attempts.listForCase('ADVERTISER_KYC', 'adv_1');
    expect(attempts.map((a) => [a.checkType, a.provider, a.status])).toEqual([['HOSTED_KYC', 'CASHFREE_SECURE_ID', 'NEEDS_USER_ACTION']]);

    expect((await request(app()).post('/api/v1/verification/cases/ADVERTISER_KYC/adv_done/resend-on-backup').set(as(admin))).body.error.code).toBe('KYC_ALREADY_VERIFIED');
    expect((await request(app()).post('/api/v1/verification/cases/ADVERTISER_KYC/adv_missing/resend-on-backup').set(as(admin))).status).toBe(404);
    expect((await request(app()).post('/api/v1/verification/cases/PAYOUT_METHOD/pm_1/resend-on-backup').set(as(admin))).body.error).toMatchObject({ code: 'BACKUP_NOT_AVAILABLE', details: { reason: 'NOT_A_KYC_CASE' } });
    wireVerification({ settings: async () => resolveVerificationSettings(null) });
    expect((await request(app()).post('/api/v1/verification/cases/ADVERTISER_KYC/adv_1/resend-on-backup').set(as(admin))).body.error).toMatchObject({ code: 'BACKUP_NOT_AVAILABLE', details: { reason: 'SWITCHED_OFF' } });
    expect((await request(app()).post('/api/v1/verification/cases/ADVERTISER_KYC/adv_1/resend-on-backup').set(as(owner))).status).toBe(403);
  });

  it('the health read: per provider the breaker, the day’s success rate and p95, and today’s failovers', async () => {
    cashfree({ ...digilockerScript, '/pan': () => reply(503, { code: 'request_failed' }) });
    await throughDigilocker();
    await request(app()).post(`/api/v1/verification/sessions/${(await open('PUBLISHER.COMPANY', true, 'pub_biz')).id}/business`).set(as(owner)).send({ pan: 'ABCCD8000T' });
    const res = await request(app()).get('/api/v1/verification/health').set(as(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ hostedKycBackup: 'ON', breakerSettings: { failures: 5, windowMinutes: 10, cooldownMinutes: 5 } });
    const cashfreeRow = res.body.data.providers.find((p: { name: string }) => p.name === 'CASHFREE_SECURE_ID');
    expect(cashfreeRow).toMatchObject({ label: 'Cashfree Secure ID', configured: true, breaker: { state: 'CLOSED', failures: 1 }, last24h: { attempts: 2, technicalFailures: 1, successRate: 50 }, failoversToday: 0 });
    expect(typeof cashfreeRow.last24h.p95LatencyMs).toBe('number');
    expect(res.body.data.providers.find((p: { name: string }) => p.name === 'DIGIO')).toMatchObject({ capabilities: ['HOSTED_KYC', 'UPI_VPA'], last24h: { attempts: 0, successRate: null, p95LatencyMs: null } });
  });
});

describe('Cashfree’s webhook', () => {
  const post = (body: string, headers: Record<string, string>) => request(app()).post('/api/v1/webhooks/cashfree/verification').set({ 'Content-Type': 'application/json', ...headers }).send(body);
  const signed = (body: string, at = Date.now()) => ({ 'x-webhook-timestamp': String(at), 'x-webhook-signature': secureIdWebhookSignature(String(at), body, KEYS.clientSecret), 'x-webhook-attempt': '1' });

  it('refuses a bad signature and a stale timestamp with 401; answers an unknown body 200', async () => {
    const body = JSON.stringify({ event_type: 'DIGILOCKER_VERIFICATION_SUCCESS', data: { verification_id: 'nope' } });
    expect((await post(body, { 'x-webhook-timestamp': String(Date.now()), 'x-webhook-signature': 'bad' })).status).toBe(401);
    expect((await post(body, signed(body, Date.now() - 10 * 60_000))).status).toBe(401);
    expect((await post(body, {})).status).toBe(401);
    const odd = JSON.stringify({ hello: 'world' });
    expect((await post(odd, signed(odd))).status).toBe(200);
  });

  it('applies a DigiLocker success to the attempt and the session, handles the same event once, and answers 200 before it works', async () => {
    cashfree(digilockerScript);
    await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker`).set(as(owner)).send({ redirectUrl: 'https://adx.in/back' });
    const [attempt] = await verificationRuntime().attempts.listForCase('PUBLISHER_KYC', 'pub_1');
    expect(attempt?.status).toBe('NEEDS_USER_ACTION');

    const body = JSON.stringify({ event_type: 'DIGILOCKER_VERIFICATION_SUCCESS', event_time: '2026-10-01T10:00:00Z', version: 'v1', data: { ...AUTHENTICATED, verification_id: attempt!.verificationId } });
    const first = await post(body, signed(body));
    expect(first.status).toBe(200);
    await secureIdWebhookSettled();
    expect((await verificationRuntime().attempts.find(attempt!.id))).toMatchObject({ status: 'VERIFIED', result: { name: 'ASHA RAO', documents: { AADHAAR: { last4: '••••5647' } } } });
    expect((await verificationRuntime().sessions.find(session.id))?.steps[0]).toMatchObject({ check: 'DIGILOCKER', status: 'VERIFIED' });

    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect((await post(body, signed(body))).status).toBe(200);
    await secureIdWebhookSettled();
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    const events = (verificationRuntime().events as unknown as { rows: { eventId: string; outcome: string | null }[] }).rows;
    expect(events).toEqual([{ id: 'pe_1', provider: 'CASHFREE_SECURE_ID', eventId: `DIGILOCKER_VERIFICATION_SUCCESS:${attempt!.verificationId}`, eventType: 'DIGILOCKER_VERIFICATION_SUCCESS', outcome: 'APPLIED:VERIFIED' }]);
  });

  it('applies an async bank event by our user_id; one for nothing we asked is recorded and left', async () => {
    const opened = await verificationRuntime().attempts.open({ caseType: 'PAYOUT_METHOD', caseId: 'pm_1', checkType: 'BANK_ACCOUNT', provider: 'CASHFREE_SECURE_ID' });
    await verificationRuntime().attempts.close(opened.id, { status: 'PENDING', providerRef: '58', result: { account: '••••1772', ifscCode: 'HDFC0000001' } });
    const body = JSON.stringify({ event_type: 'BANK_ACCOUNT_VERIFICATION_SUCCESS', version: 'v2', data: { reference_id: 58, user_id: opened.id, name_at_bank: 'ASHA RAO', bank_name: 'HDFC Bank', account_status: 'VALID', account_status_code: 'ACCOUNT_IS_VALID', name_match_score: '100.00' } });
    expect((await post(body, signed(body))).status).toBe(200);
    await secureIdWebhookSettled();
    expect(await verificationRuntime().attempts.find(opened.id)).toMatchObject({ status: 'VERIFIED', nameMatchScore: 100, result: { account: '••••1772', nameAtBank: 'ASHA RAO' } });

    const unknown = JSON.stringify({ event_type: 'BANK_ACCOUNT_VERIFICATION_FAILED', version: 'v2', data: { reference_id: 999, user_id: 'nobody', account_status: 'FAILED' } });
    expect((await post(unknown, signed(unknown))).status).toBe(200);
    await secureIdWebhookSettled();
    const events = (verificationRuntime().events as unknown as { rows: { outcome: string | null }[] }).rows;
    expect(events.map((row) => row.outcome)).toEqual(['APPLIED:VERIFIED', 'NO_ATTEMPT']);
  });
});

describe('the sweep', () => {
  it('reads pending attempts back, gives up on one a day old, and expires overdue sessions down the hosted-decision road', async () => {
    cashfree({ ...digilockerScript, 'GET /digilocker': () => reply(200, { status: 'PENDING', verification_id: 'x', reference_id: 200 }) });
    await request(app()).post(`/api/v1/verification/sessions/${session.id}/digilocker`).set(as(owner)).send({ redirectUrl: 'https://adx.in/back' });
    const now = new Date();
    expect(await sweepVerification(now)).toEqual({ read: 1, settled: 0, givenUp: 0, sessionsExpired: 0 });

    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const report = await sweepVerification(later);
    expect(report).toEqual({ read: 1, settled: 1, givenUp: 1, sessionsExpired: 1 });
    const [attempt] = await verificationRuntime().attempts.listForCase('PUBLISHER_KYC', 'pub_1');
    expect(attempt).toMatchObject({ status: 'FAILED', errorClass: 'BUSINESS', failureCode: 'UNANSWERED' });
    expect((await verificationRuntime().sessions.find(session.id))?.status).toBe('EXPIRED');
    expect(outcome).toHaveBeenCalledWith({ id: `cf_${session.id}`, status: 'expired' });
  });
});
