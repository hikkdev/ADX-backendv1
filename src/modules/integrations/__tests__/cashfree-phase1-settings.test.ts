import { generateKeyPairSync } from 'crypto';
import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cashfree Phase 1 (the owner, 1 Oct 2026) — the two new cards on Settings
 * › Integrations: Secure ID (the keys) and the verification routing.
 *
 * Pinned: the Secure ID read masks the secret and never shows the public
 * key (only that one is loaded, and its fingerprint); the PUT is strict,
 * takes a PEM that parses and refuses one that does not, unfolds a
 * `\n`-escaped line, removes the key with null, and is audited without a
 * key; the routing read is the settings in force with the catalogue; the
 * PUT merges the three sub-objects key by key, refuses a fallback that is
 * the primary and a step named twice, and is audited with the resolved
 * settings before and after.
 */

const { config, audit } = vi.hoisted(() => ({
  config: { getIntegrationsConfig: vi.fn(), updateIntegrationsConfig: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...config };
});
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { integrationsRouter } from '../integrations.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/integrations', integrationsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');
const get = () => request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
const put = (section: string, patch: Record<string, unknown>) => request(app()).put('/api/v1/integrations').set('Authorization', `Bearer ${admin}`).send({ section, patch });
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string;

beforeEach(() => {
  vi.clearAllMocks();
  config.getIntegrationsConfig.mockResolvedValue({});
  config.updateIntegrationsConfig.mockResolvedValue({});
});

describe('the Secure ID card', () => {
  it('reads the client id as it is, the secret masked, the public key as a fingerprint — never the key', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ secureId: { clientId: 'CF10001', clientSecret: 'cfsk_test_abcd1234', publicKey: PEM, testMode: true } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.secureId).toMatchObject({ clientId: 'CF10001', clientSecret: '••••1234', publicKey: '••••', testMode: true, configured: true, signing: 'PUBLIC_KEY', baseUrl: 'https://sandbox.cashfree.com/verification', source: 'SETTINGS' });
    expect(res.body.data.secureId.publicKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(res.body)).not.toContain('BEGIN PUBLIC KEY');
    expect(JSON.stringify(res.body)).not.toContain('cfsk_test_abcd1234');
  });

  it('with no key on file it says so (the client pair may still come from the environment)', async () => {
    const res = await get();
    expect(res.body.data.secureId).toMatchObject({ publicKey: null, publicKeyFingerprint: null, signing: 'IP_WHITELIST' });
    expect(res.body.data.secureId.clientSecret === null || /^••••/.test(res.body.data.secureId.clientSecret)).toBe(true);
    expect(typeof res.body.data.secureId.configured).toBe('boolean');
  });

  it('the PUT is strict, takes a PEM that parses (a \\n-escaped line unfolded), refuses one that does not, and is audited without a key', async () => {
    const folded = PEM.replace(/\n/g, '\\n');
    const res = await put('secureId', { clientId: 'CF10001', clientSecret: 'cfsk_1', publicKey: folded, testMode: false });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('secureId', { clientId: 'CF10001', clientSecret: 'cfsk_1', publicKey: PEM.trim(), testMode: false });
    const auditCall = audit.logActivity.mock.calls.find((call) => call[1] === 'SECURE_ID_CONFIG_UPDATED');
    expect(auditCall).toBeDefined();
    const { req: _req, ...written } = auditCall?.[2] as Record<string, unknown>;
    expect(JSON.stringify(written)).not.toContain('cfsk_1');
    expect(JSON.stringify(written)).not.toContain('BEGIN PUBLIC KEY');
    expect(auditCall?.[2]).toMatchObject({ diff: { testMode: { before: null, after: false }, publicKeySet: { before: false, after: true } } });

    expect((await put('secureId', { publicKey: 'not a key' })).status).toBe(400);
    expect((await put('secureId', { publicKey: PEM.replace('PUBLIC', 'PRIVATE') })).status).toBe(400);
    expect((await put('secureId', { stray: 'x' })).status).toBe(400);
    expect((await put('secureId', { publicKey: null })).status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenLastCalledWith('secureId', { publicKey: null });
  });
});

describe('the routing card', () => {
  it('reads the settings in force with the catalogue', async () => {
    const res = await get();
    const routing = res.body.data.verificationRouting;
    expect(routing).toMatchObject({
      checks: { HOSTED_KYC: { primary: 'DIGIO', fallbacks: ['CASHFREE_SECURE_ID'] }, PAN: { primary: 'CASHFREE_SECURE_ID', fallbacks: [] } },
      breaker: { failures: 5, windowMinutes: 10, cooldownMinutes: 5 },
      nameMatchMin: 80,
      upiCheck: 'VPA_LOOKUP',
      hostedKycBackup: 'OFF',
    });
    expect(Object.keys(routing.composites)).toHaveLength(25);
    expect(routing.composites['ADVERTISER.INDIVIDUAL']).toEqual([{ step: 'DIGILOCKER', required: true }, { step: 'FACE_LIVENESS', required: true }, { step: 'FACE_MATCH', required: true }]);
    expect(routing.catalogue.providers).toEqual([
      { name: 'DIGIO', label: 'Digio', capabilities: ['HOSTED_KYC', 'UPI_VPA'] },
      { name: 'CASHFREE_SECURE_ID', label: 'Cashfree Secure ID', capabilities: expect.arrayContaining(['PAN', 'BANK_ACCOUNT', 'DIGILOCKER', 'HOSTED_KYC', 'UPI_VPA']) },
    ]);
    // 2 Oct 2026: the UPI ID goes to Digio's lookup first, Cashfree's penny drop second.
    expect(routing.checks.UPI_VPA).toEqual({ primary: 'DIGIO', fallbacks: ['CASHFREE_SECURE_ID'] });
    expect(routing.catalogue.upiChecks).toEqual(['VPA_LOOKUP', 'PENNY_DROP', 'REVERSE_PENNY_DROP', 'NONE']);
  });

  it('carries the defaults beside the settings in force, so a reset can show what it restores', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ verificationRouting: { checks: { PAN: { primary: 'DIGIO' } }, composites: { AGENT: [{ step: 'PAN' }] }, nameMatchMin: 90 } });
    const routing = (await get()).body.data.verificationRouting;
    expect(routing.checks.PAN.primary).toBe('DIGIO');
    expect(routing.defaults.checks.PAN).toEqual({ primary: 'CASHFREE_SECURE_ID', fallbacks: [] });
    expect(routing.composites.AGENT).toEqual([{ step: 'PAN', required: true }]);
    expect(routing.defaults.composites.AGENT.map((step: { step: string }) => step.step)).toEqual(['DIGILOCKER', 'FACE_LIVENESS', 'FACE_MATCH', 'DRIVING_LICENCE', 'VEHICLE_RC', 'BANK_ACCOUNT', 'NAME_MATCH']);
    expect(routing.defaults).toMatchObject({ nameMatchMin: 80, breaker: { failures: 5, windowMinutes: 10, cooldownMinutes: 5 } });
  });

  it('the PUT merges checks, breaker and composites key by key, writes the switches, refuses a bad route or a repeated step, and is audited with the settings before and after', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ verificationRouting: { checks: { PAN: { primary: 'DIGIO' } }, breaker: { failures: 3 }, composites: { AGENT: [{ step: 'PAN' }] } } });
    const res = await put('verificationRouting', {
      checks: { HOSTED_KYC: { primary: 'CASHFREE_SECURE_ID', fallbacks: ['DIGIO'] }, PAN: null },
      breaker: { cooldownMinutes: 15 },
      composites: { 'PUBLISHER.INDIVIDUAL': [{ step: 'DIGILOCKER' }, { step: 'FACE_LIVENESS', required: false }], AGENT: null },
      nameMatchMin: 85,
      upiCheck: 'PENNY_DROP',
      hostedKycBackup: 'ON',
    });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('verificationRouting', {
      checks: { HOSTED_KYC: { primary: 'CASHFREE_SECURE_ID', fallbacks: ['DIGIO'] } },
      breaker: { failures: 3, cooldownMinutes: 15 },
      composites: { 'PUBLISHER.INDIVIDUAL': [{ step: 'DIGILOCKER' }, { step: 'FACE_LIVENESS', required: false }] },
      nameMatchMin: 85,
      upiCheck: 'PENNY_DROP',
      hostedKycBackup: 'ON',
    });
    const auditCall = audit.logActivity.mock.calls.find((call) => call[1] === 'VERIFICATION_ROUTING_CHANGED');
    expect(auditCall?.[2]).toMatchObject({ targetType: 'AppConfig', targetId: 'integrations', module: 'integrations' });

    expect((await put('verificationRouting', { checks: { PAN: { primary: 'DIGIO', fallbacks: ['DIGIO'] } } })).status).toBe(400);
    expect((await put('verificationRouting', { checks: { NOPE: { primary: 'DIGIO' } } })).status).toBe(400);
    expect((await put('verificationRouting', { composites: { AGENT: [{ step: 'PAN' }, { step: 'PAN' }] } })).status).toBe(400);
    expect((await put('verificationRouting', { composites: { BOGUS: [{ step: 'PAN' }] } })).status).toBe(400);
    expect((await put('verificationRouting', { nameMatchMin: 101 })).status).toBe(400);
    expect((await put('verificationRouting', { hostedKycBackup: 'MAYBE' })).status).toBe(400);
  });
});
