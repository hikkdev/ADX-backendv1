import { describe, expect, it, vi } from 'vitest';

/**
 * AG-4 (the owner, 20 Sep 2026): the bank penny drop through Cashfree's
 * Verification Suite, behind the payout rail's seam from Lot B.
 *
 * Pinned: PENNY_DROP on a bank method asks Cashfree with the account, the
 * IFSC and the holder's name, and a live account is verified with the
 * reference and the name-match score; a dead account, a refusal and an
 * unconfigured pair are 409s the desk reads; MANUAL never asks.
 */

const { repository, cashfree } = vi.hoisted(() => ({
  repository: { findMethod: vi.fn(), updateMethod: vi.fn(async (_id: string, patch: object) => ({ id: 'pm_1', ...patch })) },
  cashfree: { verifyBankAccount: vi.fn() },
}));

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => ({ ensureWallet: vi.fn(), move: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../notifications', () => ({ notify: vi.fn(), createNotification: vi.fn() }));
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../../shared/integrations', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../shared/integrations')>()), verifyBankAccount: cashfree.verifyBankAccount }));

import { verifyMethod } from '../payouts.service';

const method = { id: 'pm_1', userId: 'usr_1', type: 'BANK', accountHolder: 'Deepak Rao', accountNumber: '1234567890', ifscCode: 'HDFC0001234', status: 'PENDING_VERIFICATION' };

describe('the penny drop', () => {
  it('asks Cashfree and verifies a live account with the reference and the name match', async () => {
    repository.findMethod.mockResolvedValue(method);
    cashfree.verifyBankAccount.mockResolvedValueOnce({ ok: true, facts: { valid: true, accountStatus: 'VALID', nameAtBank: 'DEEPAK RAO', nameMatchScore: 92.5, referenceId: 'b_1', utr: 'UTR1' }, raw: {} });
    const row = await verifyMethod('pm_1', { via: 'PENNY_DROP', byUserId: 'adm_1' }, new Date('2026-09-21T00:00:00Z'));
    expect(cashfree.verifyBankAccount).toHaveBeenCalledWith({ accountNumber: '1234567890', ifsc: 'HDFC0001234', name: 'Deepak Rao' });
    expect(row).toMatchObject({ status: 'VERIFIED', verifiedVia: 'PENNY_DROP', verificationReference: 'b_1', verifiedByUserId: 'adm_1' });
    expect(String((row as { nameMatchPct: unknown }).nameMatchPct)).toBe('92.5');
  });

  it('a dead account, a refusal and an unconfigured pair are 409s; MANUAL never asks', async () => {
    repository.findMethod.mockResolvedValue(method);
    cashfree.verifyBankAccount.mockResolvedValueOnce({ ok: true, facts: { valid: false, accountStatus: 'INVALID', nameAtBank: null, nameMatchScore: null, referenceId: 'b_2', utr: null }, raw: {} });
    await expect(verifyMethod('pm_1', { via: 'PENNY_DROP', byUserId: 'adm_1' })).rejects.toMatchObject({ statusCode: 409, code: 'VERIFICATION_UNAVAILABLE', message: 'Cashfree says the account is INVALID' });
    cashfree.verifyBankAccount.mockResolvedValueOnce({ ok: false, code: 'REFUSED', status: 403, message: 'IP not whitelisted' });
    await expect(verifyMethod('pm_1', { via: 'PENNY_DROP', byUserId: 'adm_1' })).rejects.toMatchObject({ statusCode: 409, code: 'VERIFICATION_UNAVAILABLE', message: 'IP not whitelisted' });
    cashfree.verifyBankAccount.mockResolvedValueOnce({ ok: false, code: 'UNCONFIGURED', message: 'Cashfree verification is not configured; check by hand.' });
    await expect(verifyMethod('pm_1', { via: 'PENNY_DROP', byUserId: 'adm_1' })).rejects.toMatchObject({ statusCode: 409, details: { code: 'UNCONFIGURED' } });

    cashfree.verifyBankAccount.mockClear();
    const manual = await verifyMethod('pm_1', { via: 'MANUAL', reference: 'seen the passbook', byUserId: 'adm_1' });
    expect(cashfree.verifyBankAccount).not.toHaveBeenCalled();
    expect(manual).toMatchObject({ status: 'VERIFIED', verifiedVia: 'MANUAL', verificationReference: 'seen the passbook' });
  });
});
