import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Payout methods and the UPI check (the owner, 2 Oct 2026).
 *
 * Pinned through the REAL router and the real Digio provider, with `fetch`
 * stubbed (no call leaves the process): the desk's PENNY_DROP on a UPI
 * method runs Digio's VPA lookup with no consent — a live ID with a matching
 * name is VERIFIED and recorded as the bank penny drop records it (via,
 * reference, the score), not found and a name that does not match are 409s
 * that carry the answer, nobody answering is a 503; NONE keeps today's 409;
 * a person adding their own UPI ID is checked as it is added — verified,
 * flagged, or left for the desk — and the method saves either way.
 */

const { repository, kyc } = vi.hoisted(() => ({
  repository: {
    findMethod: vi.fn(),
    findHolderName: vi.fn(async () => null as string | null),
    updateMethod: vi.fn(async (id: string, patch: object) => ({ id, type: 'UPI', ...patch })),
    countMethodsForUser: vi.fn(async () => 0),
    createMethod: vi.fn(async (data: object) => ({ id: 'pm_new', status: 'PENDING_VERIFICATION', accountHolder: null, ...data })),
  },
  kyc: { config: { clientId: 'digio_client', clientSecret: 'digio_secret', baseUrl: 'https://api.digio.in', kycProvider: 'DIGIO' } as Record<string, unknown> },
}));

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => ({ ensureWallet: vi.fn(), move: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../notifications', () => ({ notify: vi.fn(), createNotification: vi.fn() }));
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../../shared/integrations/integration-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/integrations/integration-config')>()),
  getEffectiveKycConfig: vi.fn(async () => kyc.config),
}));

import { createSecureIdProvider, resetVerificationRuntime, resolveVerificationSettings, verificationRuntime, wireVerification } from '../../../shared/verification';
import { addOwnMethod, lastUpiChecks, verifyMethod, verifyMethodChecked } from '../payouts.service';

const NOW = new Date('2026-10-02T10:00:00Z');
const UPI_METHOD = { id: 'pm_upi', userId: 'usr_1', type: 'UPI', upiVpa: 'asha.rao@okhdfc', accountHolder: 'Asha Rao', accountNumber: null, ifscCode: null, status: 'PENDING_VERIFICATION' };
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const digio = (status: string, extra: Record<string, unknown> = {}) =>
  reply(200, { virtual_address: 'asha.rao@okhdfc', customer_name: 'ASHA RAO', status, status_description: `VPA is ${status}`, fuzzy_match_score: 96, ...extra });

let fetchStub: ReturnType<typeof vi.fn>;
const sent = () => JSON.parse((fetchStub.mock.calls[0] as unknown as [string, { body: string }])[1].body) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  resetVerificationRuntime();
  // Cashfree with fixed keys: the backup is never asked here (no consent), and the environment's keys are never read.
  wireVerification({ providers: { CASHFREE_SECURE_ID: createSecureIdProvider(() => ({ clientId: 'CF1', clientSecret: 'cf', testMode: true })) } });
  fetchStub = vi.fn(async () => digio('available'));
  vi.stubGlobal('fetch', fetchStub);
  repository.findMethod.mockResolvedValue(UPI_METHOD);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetVerificationRuntime();
});

describe('the desk checks a UPI ID', () => {
  it('runs Digio’s lookup with the holder’s name and no consent; a live, matching ID is verified as a NAME_LOOKUP with the reference and the score', async () => {
    const { method, check } = await verifyMethodChecked('pm_upi', { via: 'PENNY_DROP', byUserId: 'adm_1' }, NOW);
    expect((fetchStub.mock.calls[0] as unknown as [string])[0]).toBe('https://api.digio.in/v3/client/public/upi/check_vpa');
    expect(sent()).toMatchObject({ reference_id: 'pm_upi', virtual_address: 'asha.rao@okhdfc', name: 'Asha Rao' });
    expect(sent()['unique_request_id']).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(repository.updateMethod).toHaveBeenCalledWith('pm_upi', expect.objectContaining({ status: 'VERIFIED', verifiedVia: 'NAME_LOOKUP', verificationReference: sent()['unique_request_id'], verifiedAt: NOW, verifiedByUserId: 'adm_1', rejectionReason: null }));
    expect(String((method as { nameMatchPct: unknown }).nameMatchPct)).toBe('96');
    expect(check).toMatchObject({ check: 'UPI_VPA', outcome: 'VERIFIED', provider: 'DIGIO', providerLabel: 'Digio', nameAtBank: 'ASHA RAO', nameMatchScore: 96 });
    // The attempt is on record against the method.
    const attempts = await verificationRuntime().attempts.listForCase('PAYOUT_METHOD', 'pm_upi');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ provider: 'DIGIO', checkType: 'UPI_VPA', status: 'VERIFIED' });
  });

  it('not found and a name under the bar are 409 VERIFICATION_UNAVAILABLE carrying the answer; nothing is marked', async () => {
    fetchStub.mockResolvedValueOnce(digio('not_available', { customer_name: null }));
    await expect(verifyMethod('pm_upi', { via: 'PENNY_DROP', byUserId: 'adm_1' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'VERIFICATION_UNAVAILABLE',
      message: 'This UPI ID is not active, or does not exist.',
      details: { code: 'NOT_FOUND', check: { outcome: 'NOT_FOUND', provider: 'DIGIO' } },
    });
    fetchStub.mockResolvedValueOnce(digio('available', { customer_name: 'RAVI KUMAR', fuzzy_match_score: 35 }));
    await expect(verifyMethod('pm_upi', { via: 'PENNY_DROP', byUserId: 'adm_1' })).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'NAME_MISMATCH', check: { outcome: 'NAME_MISMATCH', nameAtBank: 'RAVI KUMAR', nameMatchScore: 35 } },
    });
    expect(repository.updateMethod).not.toHaveBeenCalled();
  });

  it('nobody answering is 503 VERIFICATION_UNAVAILABLE with a sentence a person can read — Cashfree is not asked without consent', async () => {
    fetchStub.mockResolvedValue(reply(503, {}));
    await expect(verifyMethod('pm_upi', { via: 'PENNY_DROP', byUserId: 'adm_1' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'VERIFICATION_UNAVAILABLE',
      message: 'This UPI ID could not be checked just now. Try again in a few minutes, or verify it by hand.',
      details: { code: 'UNAVAILABLE' },
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(repository.updateMethod).not.toHaveBeenCalled();

    // Digio with no keys: nothing to ask at all — still the 503.
    kyc.config = { baseUrl: 'https://api.digio.in' };
    fetchStub.mockClear();
    await expect(verifyMethod('pm_upi', { via: 'PENNY_DROP', byUserId: 'adm_1' })).rejects.toMatchObject({ statusCode: 503, code: 'VERIFICATION_UNAVAILABLE' });
    expect(fetchStub).not.toHaveBeenCalled();
    kyc.config = { clientId: 'digio_client', clientSecret: 'digio_secret', baseUrl: 'https://api.digio.in', kycProvider: 'DIGIO' };
  });

  it('NONE keeps the 409 UPI_CHECK_NOT_CONFIGURED; a penny-drop setting still needs the holder; MANUAL never asks', async () => {
    wireVerification({ settings: async () => resolveVerificationSettings({ upiCheck: 'NONE' }) });
    await expect(verifyMethod('pm_upi', { via: 'PENNY_DROP', byUserId: 'adm_1' })).rejects.toMatchObject({ statusCode: 409, code: 'UPI_CHECK_NOT_CONFIGURED', details: { upiCheck: 'NONE', reason: 'NOT_CHOSEN' } });
    wireVerification({ settings: async () => resolveVerificationSettings({ upiCheck: 'PENNY_DROP' }) });
    await expect(verifyMethod('pm_upi', { via: 'PENNY_DROP', byUserId: 'adm_1' })).rejects.toMatchObject({ statusCode: 409, code: 'UPI_CHECK_NOT_CONFIGURED', details: { upiCheck: 'PENNY_DROP', reason: 'NEEDS_ACCOUNT_HOLDER' } });
    expect(fetchStub).not.toHaveBeenCalled();
    const manual = await verifyMethodChecked('pm_upi', { via: 'MANUAL', reference: 'collect request confirmed', byUserId: 'adm_1' }, NOW);
    expect(manual.check).toBeNull();
    expect(manual.method).toMatchObject({ status: 'VERIFIED', verifiedVia: 'MANUAL' });
  });
});

describe('the name a UPI ID is matched against', () => {
  it('is the owner’s own name when the method names no holder — the app and website forms ask for none', async () => {
    repository.findMethod.mockResolvedValue({ ...UPI_METHOD, accountHolder: null });
    repository.findHolderName.mockResolvedValue('Asha Rao');
    await verifyMethodChecked('pm_upi', { via: 'PENNY_DROP', byUserId: 'adm_1' }, NOW);
    expect(sent()).toMatchObject({ name: 'Asha Rao' });
  });

  it('sends no name when neither is known, rather than failing the check', async () => {
    repository.findMethod.mockResolvedValue({ ...UPI_METHOD, accountHolder: null });
    repository.findHolderName.mockRejectedValue(new Error('read failed'));
    await verifyMethodChecked('pm_upi', { via: 'PENNY_DROP', byUserId: 'adm_1' }, NOW);
    expect(sent()).not.toHaveProperty('name');
  });
});

describe('a person adds their own UPI ID', () => {
  it('is checked as it is added and verified on a live, matching ID — by nobody at the desk', async () => {
    const { method, check } = await addOwnMethod('usr_1', { type: 'UPI', upiVpa: ' asha.rao@okhdfc ', accountHolder: 'Asha Rao' }, NOW);
    expect(repository.createMethod).toHaveBeenCalledWith(expect.objectContaining({ type: 'UPI', upiVpa: 'asha.rao@okhdfc', accountHolder: 'Asha Rao', isDefault: true }));
    expect(sent()).toMatchObject({ virtual_address: 'asha.rao@okhdfc', name: 'Asha Rao' });
    expect(repository.updateMethod).toHaveBeenCalledWith('pm_new', expect.objectContaining({ status: 'VERIFIED', verifiedVia: 'NAME_LOOKUP', verifiedByUserId: null }));
    expect(method).toMatchObject({ status: 'VERIFIED' });
    expect(check).toMatchObject({ outcome: 'VERIFIED', nameAtBank: 'ASHA RAO' });
  });

  it('a VPA not found or a name that does not match is FLAGGED: saved, unverified, the answer beside it — and the desk’s queue shows it', async () => {
    fetchStub.mockResolvedValueOnce(digio('not_available', { customer_name: null }));
    const notFound = await addOwnMethod('usr_1', { type: 'UPI', upiVpa: 'nobody@okhdfc' }, NOW);
    expect(notFound.method).toMatchObject({ id: 'pm_new', status: 'PENDING_VERIFICATION' });
    expect(notFound.check).toMatchObject({ outcome: 'NOT_FOUND' });
    expect(sent()).not.toHaveProperty('name');
    expect(repository.updateMethod).not.toHaveBeenCalled();

    const queue = await lastUpiChecks([{ ...UPI_METHOD, id: 'pm_new' } as never, { id: 'pm_bank', type: 'BANK' } as never]);
    expect(queue.get('pm_new')).toMatchObject({ check: 'UPI_VPA', outcome: 'NOT_FOUND', provider: 'DIGIO' });
    expect(queue.has('pm_bank')).toBe(false);
  });

  it('a technical failure leaves it unverified for the desk; the method saves either way', async () => {
    fetchStub.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    const { method, check } = await addOwnMethod('usr_1', { type: 'UPI', upiVpa: 'asha.rao@okhdfc' }, NOW);
    expect(repository.createMethod).toHaveBeenCalledTimes(1);
    expect(method).toMatchObject({ status: 'PENDING_VERIFICATION' });
    expect(check).toMatchObject({ outcome: 'UNAVAILABLE' });
    expect(repository.updateMethod).not.toHaveBeenCalled();
  });

  it('is not checked when the UPI check is not the VPA lookup, and a bank account is never UPI-checked', async () => {
    wireVerification({ settings: async () => resolveVerificationSettings({ upiCheck: 'NONE' }) });
    expect(await addOwnMethod('usr_1', { type: 'UPI', upiVpa: 'asha.rao@okhdfc' }, NOW)).toMatchObject({ check: null, method: { status: 'PENDING_VERIFICATION' } });
    wireVerification({ settings: async () => resolveVerificationSettings({ upiCheck: 'PENNY_DROP' }) });
    expect((await addOwnMethod('usr_1', { type: 'UPI', upiVpa: 'asha.rao@okhdfc' }, NOW)).check).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
