import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cashfree Phase 1 (the owner, 1 Oct 2026: "Go ahead, Encrypt it") — the
 * integrations row's secrets, sealed at rest.
 *
 * Pinned: the stored form and the round trip; a tampered or foreign
 * ciphertext is refused; the database AND the cache hold ciphertext while
 * the code reads plaintext; a row written before the key existed reads as
 * it is and is sealed the next time it is written; with no key development
 * keeps plaintext and warns once, production refuses to store a secret
 * (503 ENCRYPTION_KEY_MISSING) but still saves a patch that carries none;
 * a secret sealed under another key reads as absent and is never destroyed
 * by a later save; and the registry of secret fields covers every field
 * the read mapper masks.
 */

const { store, log } = vi.hoisted(() => ({
  store: { row: null as null | { key: string; value: unknown }, cache: new Map<string, string>() },
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../database/prisma', () => ({
  prisma: {
    appConfig: {
      findUnique: vi.fn(async () => store.row),
      upsert: vi.fn(async ({ update, create }: { update: { value: unknown }; create: { key: string; value: unknown } }) => {
        store.row = store.row ? { ...store.row, value: update.value } : { key: create.key, value: create.value };
        return store.row;
      }),
    },
    $disconnect: vi.fn(async () => undefined),
  },
}));
vi.mock('../../cache/redis', () => ({
  redis: {
    get: vi.fn(async (key: string) => store.cache.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.cache.set(key, value);
      return 'OK';
    }),
    disconnect: vi.fn(),
  },
}));
vi.mock('../../logging', () => ({ logger: log }));

import { env } from '../../../config/env';
import { getEffectiveSecureIdConfig, getIntegrationsConfig, sealStoredIntegrationsRow, updateIntegrationsConfig } from '../integration-config';
import {
  INTEGRATION_SECRET_FIELDS,
  SECRET_PREFIX,
  assertSecretsStorable,
  describeIntegrationSecrets,
  isSealed,
  openIntegrationSecrets,
  openSecret,
  patchCarriesSecret,
  resetSecretBoxWarnings,
  sealIntegrationSecrets,
  sealSecret,
} from '../secret-box';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const mutableEnv = env as { INTEGRATIONS_ENCRYPTION_KEY?: string | undefined; NODE_ENV: string };
const original = { key: env.INTEGRATIONS_ENCRYPTION_KEY, nodeEnv: env.NODE_ENV };

const storedValue = () => store.row?.value as Record<string, Record<string, unknown>>;
const cachedValue = () => JSON.parse(store.cache.get('config:integrations') ?? '{}') as Record<string, Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  store.row = null;
  store.cache.clear();
  resetSecretBoxWarnings();
  mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  mutableEnv.NODE_ENV = 'test';
});

afterEach(() => {
  mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = original.key;
  mutableEnv.NODE_ENV = original.nodeEnv;
});

describe('the box', () => {
  const key = Buffer.from(KEY, 'base64');

  it('seals to enc:v1:<iv>:<tag>:<ciphertext> and opens to what went in', () => {
    const sealed = sealSecret('cfsk_live_abc123', key);
    expect(sealed.startsWith(SECRET_PREFIX)).toBe(true);
    expect(sealed.slice(SECRET_PREFIX.length).split(':')).toHaveLength(3);
    expect(sealed).not.toContain('cfsk_live_abc123');
    expect(openSecret(sealed, key)).toBe('cfsk_live_abc123');
    // A PEM survives whole — newlines and all.
    const pem = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\nkqhkiG9w0B\n-----END PUBLIC KEY-----';
    expect(openSecret(sealSecret(pem, key), key)).toBe(pem);
  });

  it('never seals the same value to the same text twice (a fresh IV each time)', () => {
    expect(sealSecret('same', key)).not.toBe(sealSecret('same', key));
  });

  it('refuses a ciphertext that was altered, and one sealed under another key', () => {
    const sealed = sealSecret('secret', key);
    const parts = sealed.split(':');
    const flipped = [...parts.slice(0, 4), Buffer.from('tampered').toString('base64')].join(':');
    expect(() => openSecret(flipped, key)).toThrow();
    expect(() => openSecret(sealed, Buffer.from(OTHER_KEY, 'base64'))).toThrow();
    expect(() => openSecret('plain', key)).toThrow('Not a sealed secret');
  });

  it('accepts the key as 64 hex characters too', () => {
    mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const sealed = sealIntegrationSecrets({ resend: { apiKey: 're_123' } });
    expect(isSealed(sealed.resend.apiKey)).toBe(true);
    expect(openIntegrationSecrets(sealed).resend.apiKey).toBe('re_123');
  });
});

describe('the row', () => {
  it('seals every registered secret — nested cards too — and leaves everything else as it is', () => {
    const row = {
      sms: { authKey: 'msg91-key', senderId: 'ADXIND' },
      maps: { provider: 'OSM', googleServerKey: 'AIza-server', osm: { tileApiKey: 'tile-key', contactEmail: 'ops@adx.in' } },
      leadForms: { meta: { appSecret: 'meta-secret', verifyToken: 'verify' } },
      leadChannels: { telephony: { apiToken: 'exotel-token', callerIds: ['08047100000'] } },
      secureId: { clientId: 'CF10001', clientSecret: 'cfsk_secret', publicKey: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----', testMode: true },
      verificationRouting: { hostedKycBackup: 'ON' },
    };
    const sealed = sealIntegrationSecrets(row);
    for (const value of [sealed.sms.authKey, sealed.maps.googleServerKey, sealed.maps.osm.tileApiKey, sealed.leadForms.meta.appSecret, sealed.leadForms.meta.verifyToken, sealed.leadChannels.telephony.apiToken, sealed.secureId.clientSecret, sealed.secureId.publicKey]) {
      expect(isSealed(value)).toBe(true);
    }
    expect(sealed.sms.senderId).toBe('ADXIND');
    expect(sealed.maps.provider).toBe('OSM');
    expect(sealed.maps.osm.contactEmail).toBe('ops@adx.in');
    expect(sealed.leadChannels.telephony.callerIds).toEqual(['08047100000']);
    expect(sealed.secureId.clientId).toBe('CF10001');
    expect(sealed.secureId.testMode).toBe(true);
    expect(sealed.verificationRouting).toEqual({ hostedKycBackup: 'ON' });
    // The input is not touched, and the round trip gives it back.
    expect(row.sms.authKey).toBe('msg91-key');
    expect(openIntegrationSecrets(sealed)).toEqual(row);
  });

  it('reads a value without the prefix as plaintext — a row written before the key existed keeps working', () => {
    const legacy = { razorpay: { keyId: 'rzp_test_1', keySecret: 'plain-secret' } };
    expect(openIntegrationSecrets(legacy)).toEqual(legacy);
    expect(describeIntegrationSecrets(legacy)).toEqual([{ field: 'razorpay.keySecret', state: 'PLAINTEXT' }]);
  });

  it('a secret sealed under another key reads as absent, is named once in the log, and is never re-sealed or lost', () => {
    mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = OTHER_KEY;
    const foreign = sealIntegrationSecrets({ stripe: { secretKey: 'sk_live_1', publishableKey: 'pk_live_1' } });
    mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = KEY;

    const opened = openIntegrationSecrets(foreign);
    expect(opened.stripe.secretKey).toBeUndefined();
    expect(opened.stripe.publishableKey).toBe('pk_live_1');
    openIntegrationSecrets(foreign);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![1]).toEqual({ field: 'stripe.secretKey', keyPresent: true });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(foreign.stripe.secretKey);

    expect(sealIntegrationSecrets(foreign).stripe.secretKey).toBe(foreign.stripe.secretKey);
    expect(describeIntegrationSecrets(foreign)).toEqual([{ field: 'stripe.secretKey', state: 'UNREADABLE' }]);
  });
});

describe('the stored row and the cache', () => {
  it('hold ciphertext; the code reads plaintext', async () => {
    await updateIntegrationsConfig('secureId', { clientId: 'CF10001', clientSecret: 'cfsk_secret', testMode: true });

    expect(isSealed(storedValue()['secureId']!['clientSecret'])).toBe(true);
    expect(isSealed(cachedValue()['secureId']!['clientSecret'])).toBe(true);
    expect(storedValue()['secureId']!['clientId']).toBe('CF10001');
    expect(JSON.stringify(store.row)).not.toContain('cfsk_secret');
    expect([...store.cache.values()].join('')).not.toContain('cfsk_secret');

    expect((await getIntegrationsConfig()).secureId).toEqual({ clientId: 'CF10001', clientSecret: 'cfsk_secret', testMode: true });
    expect(await getEffectiveSecureIdConfig()).toMatchObject({ clientId: 'CF10001', clientSecret: 'cfsk_secret', testMode: true });
  });

  it('a legacy plaintext row is read as it is and sealed the next time ANY section is written', async () => {
    store.row = { key: 'integrations', value: { razorpay: { keyId: 'rzp_1', keySecret: 'old-plain' }, kyc: { kycProvider: 'DIGIO' } } };
    expect((await getIntegrationsConfig()).razorpay?.keySecret).toBe('old-plain');

    await updateIntegrationsConfig('kyc', { kycProvider: 'MANUAL' });
    expect(isSealed(storedValue()['razorpay']!['keySecret'])).toBe(true);
    expect(storedValue()['kyc']).toEqual({ kycProvider: 'MANUAL' });
    expect((await getIntegrationsConfig()).razorpay?.keySecret).toBe('old-plain');
  });

  it('blank keeps a sealed secret, a new value replaces it, null clears it', async () => {
    await updateIntegrationsConfig('cashfree', { appId: 'app_1', secretKey: 'first' });
    const first = storedValue()['cashfree']!['secretKey'];
    await updateIntegrationsConfig('cashfree', { appId: 'app_2', secretKey: '' });
    expect(storedValue()['cashfree']!['secretKey']).toBe(first);
    expect((await getIntegrationsConfig()).cashfree).toEqual({ appId: 'app_2', secretKey: 'first' });
    await updateIntegrationsConfig('cashfree', { secretKey: 'second' });
    expect((await getIntegrationsConfig()).cashfree?.secretKey).toBe('second');
    await updateIntegrationsConfig('cashfree', { secretKey: null });
    expect((await getIntegrationsConfig()).cashfree).toEqual({ appId: 'app_2' });
  });

  it('a save on a machine with the wrong key leaves another key’s ciphertext exactly where it was', async () => {
    mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = OTHER_KEY;
    await updateIntegrationsConfig('resend', { apiKey: 're_live', fromEmail: 'ADX <no-reply@mail.adx.in>' });
    const foreign = storedValue()['resend']!['apiKey'];
    mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = KEY;
    store.cache.clear();

    await updateIntegrationsConfig('resend', { fromEmail: 'ADX <hello@mail.adx.in>' });
    expect(storedValue()['resend']).toEqual({ apiKey: foreign, fromEmail: 'ADX <hello@mail.adx.in>' });
  });

  it('integrations:encrypt — the write seals what is still plaintext and is idempotent', async () => {
    store.row = { key: 'integrations', value: { ai: { apiKey: 'sk-ant-plain', enabled: true }, twilio: { authToken: 'tw-plain' } } };
    const sealed = await sealStoredIntegrationsRow();
    expect(describeIntegrationSecrets(sealed).map((row) => row.state)).toEqual(['SEALED', 'SEALED']);
    const once = JSON.stringify(store.row);
    await sealStoredIntegrationsRow();
    expect(JSON.stringify(store.row)).toBe(once);
    expect((await getIntegrationsConfig()).ai).toEqual({ apiKey: 'sk-ant-plain', enabled: true });
  });
});

describe('with no key', () => {
  beforeEach(() => {
    mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = undefined;
  });

  it('development keeps the row in plaintext and says so ONCE', async () => {
    await updateIntegrationsConfig('twilio', { accountSid: 'AC1', authToken: 'plain-token' });
    expect(storedValue()['twilio']).toEqual({ accountSid: 'AC1', authToken: 'plain-token' });
    await getIntegrationsConfig();
    await updateIntegrationsConfig('twilio', { phoneNumber: '+15550001111' });
    expect((await getIntegrationsConfig()).twilio?.authToken).toBe('plain-token');
    const warnings = log.warn.mock.calls.filter((call) => String(call[0]).includes('INTEGRATIONS_ENCRYPTION_KEY'));
    expect(warnings).toHaveLength(1);
  });

  it('production refuses to store a secret — 503 ENCRYPTION_KEY_MISSING — and nothing is written', async () => {
    mutableEnv.NODE_ENV = 'production';
    await expect(updateIntegrationsConfig('secureId', { clientId: 'CF1', clientSecret: 'cfsk' })).rejects.toMatchObject({ statusCode: 503, code: 'ENCRYPTION_KEY_MISSING', details: { section: 'secureId' } });
    await expect(updateIntegrationsConfig('leadForms', { meta: { appSecret: 'x' } })).rejects.toMatchObject({ code: 'ENCRYPTION_KEY_MISSING' });
    expect(store.row).toBeNull();
  });

  it('production still saves a patch that carries no secret — the probe flips the Digio switch without the key', async () => {
    mutableEnv.NODE_ENV = 'production';
    await updateIntegrationsConfig('kyc', { kycProvider: 'DEGRADED' });
    await updateIntegrationsConfig('secureId', { clientId: 'CF1', clientSecret: '', testMode: false });
    expect(storedValue()['kyc']).toEqual({ kycProvider: 'DEGRADED' });
    expect(storedValue()['secureId']).toEqual({ clientId: 'CF1', testMode: false });
  });

  it('a sealed secret cannot be read without the key: it reads as not set', () => {
    mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = KEY;
    const sealed = sealIntegrationSecrets({ ai: { apiKey: 'sk-1' } });
    mutableEnv.INTEGRATIONS_ENCRYPTION_KEY = undefined;
    expect(openIntegrationSecrets(sealed).ai.apiKey).toBeUndefined();
    expect(log.error.mock.calls[0]![1]).toEqual({ field: 'ai.apiKey', keyPresent: false });
  });
});

describe('what counts as a secret', () => {
  it('a patch carries one only when it writes a non-empty value on a registered field', () => {
    expect(patchCarriesSecret('secureId', { clientSecret: 'x' })).toBe(true);
    expect(patchCarriesSecret('secureId', { clientSecret: '', clientId: 'CF1' })).toBe(false);
    expect(patchCarriesSecret('secureId', { publicKey: null })).toBe(false);
    expect(patchCarriesSecret('maps', { osm: { tileApiKey: 'k' } })).toBe(true);
    expect(patchCarriesSecret('leadFeeds', { justdial: { endpoint: 'https://x' } })).toBe(false);
    expect(patchCarriesSecret('verificationRouting', { upiCheck: 'PENNY_DROP' })).toBe(false);
    expect(() => assertSecretsStorable('secureId', { clientSecret: 'x' })).not.toThrow();
  });

  it('the registry covers every field the read mapper masks', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../modules/integrations/integrations.mapper.ts'), 'utf8');
    const masked = new Set<string>();
    for (const match of source.matchAll(/maskSecret\(([^\n]*)/g)) {
      for (const field of match[1]!.matchAll(/cfg\.(\w+)\?\.(\w+)(?:\?\.(\w+))?/g)) masked.add(`${field[1]}.${field[3] ? `${field[2]}.${field[3]}` : field[2]}`);
    }
    // The fallbacks a masked expression reads through (`cfg.kyc?.clientId` behind `esign`) are secrets too; the count guards the regex.
    expect(masked.size).toBeGreaterThan(40);
    const registered = new Set(Object.entries(INTEGRATION_SECRET_FIELDS).flatMap(([section, fields]) => fields.map((field) => `${section}.${field}`)));
    expect([...masked].filter((field) => !registered.has(field))).toEqual([]);
    // The four the regex cannot see: a computed card key, a resolved sub-object, and the Secure ID view's locals.
    for (const field of ['leadFeeds.justdial.apiKey', 'leadFeeds.rera.apiKey', 'maps.osm.tileApiKey', 'secureId.clientSecret', 'secureId.publicKey']) expect(registered.has(field)).toBe(true);
  });
});
