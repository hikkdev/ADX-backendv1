import { createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFcmSender, readServiceAccount, signJwtGrant } from '../fcm';

/**
 * The FCM door — G6 (Q103/133).
 *
 * What is pinned: the service account reads raw or base64 and a missing or
 * malformed one is a `skipped`, never a throw; the JWT grant is RS256 over
 * the right claims and verifies with the public key; the bearer is minted
 * once and cached, re-minted on a 401; FCM's answers are classified so the
 * caller can tell a stale token from an outage; nothing here throws on
 * FCM's own answer.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  project_id: 'adx-test',
  client_email: 'push@adx-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const raw = JSON.stringify(account);

const response = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }) as unknown as Response;

describe('readServiceAccount', () => {
  it('reads raw JSON and base64 JSON, and says why when it cannot', () => {
    expect(readServiceAccount(raw).account?.project_id).toBe('adx-test');
    expect(readServiceAccount(Buffer.from(raw).toString('base64')).account?.client_email).toBe(account.client_email);
    expect(readServiceAccount(undefined)).toEqual({ account: null, reason: 'FCM_NOT_CONFIGURED' });
    expect(readServiceAccount('   ')).toEqual({ account: null, reason: 'FCM_NOT_CONFIGURED' });
    expect(readServiceAccount('{"project_id":"x"}')).toEqual({ account: null, reason: 'FCM_MISCONFIGURED' });
    expect(readServiceAccount('not json at all')).toEqual({ account: null, reason: 'FCM_MISCONFIGURED' });
  });
});

describe('signJwtGrant', () => {
  it('is RS256 over the messaging scope and verifies with the public key', () => {
    const now = new Date('2026-09-14T10:00:00Z');
    const jwt = signJwtGrant(account, now);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1789380000,
      exp: 1789380000 + 3600,
    });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});

describe('createFcmSender', () => {
  const fetchImpl = vi.fn();
  beforeEach(() => fetchImpl.mockReset());

  it('answers skipped without configuration and never calls out', async () => {
    const sender = createFcmSender({ fetchImpl, serviceAccountJson: null });
    expect(await sender.send('tok', { data: { type: 'X' } })).toEqual({ skipped: true, reason: 'FCM_NOT_CONFIGURED' });
    expect(sender.isConfigured()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('mints a bearer once, sends with it, and reads the message name back', async () => {
    fetchImpl
      .mockResolvedValueOnce(response(200, { access_token: 'bearer-1', expires_in: 3600 }))
      .mockResolvedValueOnce(response(200, { name: 'projects/adx-test/messages/1' }))
      .mockResolvedValueOnce(response(200, { name: 'projects/adx-test/messages/2' }));
    const sender = createFcmSender({ fetchImpl, serviceAccountJson: raw, now: () => new Date('2026-09-14T10:00:00Z') });

    const first = await sender.send('tok-1', { notification: { title: 'T', body: 'B' }, data: { type: 'ORDER' } });
    const second = await sender.send('tok-2', { data: { type: 'FLAGS_CHANGED' } });

    expect(first).toEqual({ ok: true, messageId: 'projects/adx-test/messages/1' });
    expect(second).toEqual({ ok: true, messageId: 'projects/adx-test/messages/2' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0]!;
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(String(tokenInit.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    const [sendUrl, sendInit] = fetchImpl.mock.calls[1]!;
    expect(sendUrl).toBe('https://fcm.googleapis.com/v1/projects/adx-test/messages:send');
    expect(sendInit.headers.Authorization).toBe('Bearer bearer-1');
    const visible = JSON.parse(sendInit.body).message;
    expect(visible).toMatchObject({ token: 'tok-1', notification: { title: 'T', body: 'B' }, data: { type: 'ORDER' }, android: { priority: 'high' } });
    expect(visible.apns.headers['apns-priority']).toBe('10');
    // A silent data push wakes iOS with content-available and no sound.
    const silent = JSON.parse(fetchImpl.mock.calls[2]![1].body).message;
    expect(silent.notification).toBeUndefined();
    expect(silent.apns.headers['apns-priority']).toBe('5');
    expect(silent.apns.payload.aps).toEqual({ 'content-available': 1 });
  });

  it('classifies FCM’s answers and re-mints the bearer once on a 401', async () => {
    fetchImpl
      .mockResolvedValueOnce(response(200, { access_token: 'bearer-1', expires_in: 3600 }))
      .mockResolvedValueOnce(response(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }))
      .mockResolvedValueOnce(response(400, { error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } }))
      .mockResolvedValueOnce(response(429, 'quota'))
      .mockResolvedValueOnce(response(503, 'later'))
      .mockResolvedValueOnce(response(401, 'expired'))
      .mockResolvedValueOnce(response(200, { access_token: 'bearer-2', expires_in: 3600 }))
      .mockResolvedValueOnce(response(200, { name: 'projects/adx-test/messages/9' }));
    const sender = createFcmSender({ fetchImpl, serviceAccountJson: raw });

    expect(await sender.send('stale', { data: {} })).toMatchObject({ ok: false, error: 'UNREGISTERED', status: 404 });
    expect(await sender.send('bad', { data: {} })).toMatchObject({ ok: false, error: 'INVALID_TOKEN', status: 400 });
    expect(await sender.send('t', { data: {} })).toMatchObject({ ok: false, error: 'QUOTA' });
    expect(await sender.send('t', { data: {} })).toMatchObject({ ok: false, error: 'UNAVAILABLE' });
    expect(await sender.send('t', { data: {} })).toEqual({ ok: true, messageId: 'projects/adx-test/messages/9' });
    expect(fetchImpl.mock.calls[7]![1].headers.Authorization).toBe('Bearer bearer-2');
  });

  it('throws only when the mint itself fails', async () => {
    fetchImpl.mockResolvedValueOnce(response(500, 'token endpoint down'));
    const sender = createFcmSender({ fetchImpl, serviceAccountJson: raw });
    await expect(sender.send('t', { data: {} })).rejects.toThrow(/token endpoint answered 500/);
  });
});
