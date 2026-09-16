import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A FREEZE_WALLET — money may land, and may not leave.
 *
 * The asymmetry is the whole point: an accrual, an incentive or a goodwill
 * credit still posts against a frozen wallet, so the books stay true and a
 * publisher is not quietly under-paid for the days they worked while under
 * review. Only the debit is refused.
 */

const { repository, ledger } = vi.hoisted(() => ({
  repository: {
    ensure: vi.fn(),
    findById: vi.fn(),
    findByOwner: vi.fn(),
    snapshot: vi.fn(),
    listEntries: vi.fn(),
    move: vi.fn(),
    sumEntries: vi.fn(),
    listWallets: vi.fn(),
    freeze: vi.fn(),
    unfreeze: vi.fn(),
  },
  ledger: { ensureAccounts: vi.fn() },
}));

vi.mock('../prisma-wallets.repository', () => ({ prismaWalletsRepository: repository }));
vi.mock('../../ledger', () => ledger);

import { freezeWallet, isWalletFrozen, move, unfreezeWallet } from '../wallets.service';

const OWNER = { kind: 'PUBLISHER' as const, id: 'pub_1' };
const FROZEN_AT = new Date('2026-09-12T00:00:00Z');

const wallet = (over: Record<string, unknown> = {}) => ({
  id: 'wal_1',
  balance: '1000.00',
  goodwill: '0.00',
  frozenAt: null,
  frozenReason: null,
  frozenById: null,
  ...over,
});

const movement = (amount: string) => ({
  walletId: 'wal_1',
  walletLabel: 'Publisher wallet',
  amount,
  entryType: 'EARNING' as const,
  ledgerKind: 'PUBLISHER_EARNING' as const,
  idempotencyKey: 'test:1',
  counterLegs: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  ledger.ensureAccounts.mockResolvedValue(undefined);
  repository.findById.mockResolvedValue(wallet());
  repository.findByOwner.mockResolvedValue(wallet());
  repository.move.mockResolvedValue({ wallet: wallet(), entry: { id: 'ent_1' }, ledgerTransactionId: 'ltx_1', created: true });
  repository.freeze.mockImplementation(async (_id: string, input: Record<string, unknown>) => wallet({ frozenAt: input['at'], frozenReason: input['reason'] }));
  repository.unfreeze.mockResolvedValue(wallet());
});

describe('freezing', () => {
  it('stamps the wallet with the moment, the reason and the admin', async () => {
    await freezeWallet(OWNER, { reason: 'Fraud review', byUserId: 'usr_admin', at: FROZEN_AT });
    expect(repository.freeze).toHaveBeenCalledWith('wal_1', {
      reason: 'Fraud review',
      byUserId: 'usr_admin',
      at: FROZEN_AT,
    });
  });

  it('answers null for a party who never opened a wallet, rather than conjuring one', async () => {
    repository.findByOwner.mockResolvedValue(null);
    await expect(freezeWallet(OWNER, { reason: 'Fraud review', byUserId: 'usr_admin' })).resolves.toBeNull();
    expect(repository.freeze).not.toHaveBeenCalled();
  });

  it('thaws only a wallet that was frozen', async () => {
    repository.findByOwner.mockResolvedValue(wallet());
    await unfreezeWallet(OWNER);
    expect(repository.unfreeze).not.toHaveBeenCalled();

    repository.findByOwner.mockResolvedValue(wallet({ frozenAt: FROZEN_AT, frozenReason: 'Fraud review' }));
    await unfreezeWallet(OWNER);
    expect(repository.unfreeze).toHaveBeenCalledWith('wal_1');
  });

  it('reports the state for a gate that only wants the answer', async () => {
    repository.findByOwner.mockResolvedValue(wallet({ frozenAt: FROZEN_AT }));
    await expect(isWalletFrozen(OWNER)).resolves.toBe(true);
    repository.findByOwner.mockResolvedValue(null);
    await expect(isWalletFrozen(OWNER)).resolves.toBe(false);
  });
});

describe('moving money on a frozen wallet', () => {
  it('refuses a debit with 409 WALLET_FROZEN, before anything is written', async () => {
    repository.findById.mockResolvedValue(wallet({ frozenAt: FROZEN_AT, frozenReason: 'Fraud review' }));

    await expect(move(movement('-250.00'))).rejects.toMatchObject({
      statusCode: 409,
      code: 'WALLET_FROZEN',
    });
    expect(repository.move).not.toHaveBeenCalled();
  });

  it('still lands a credit, so a day worked is still a day earned', async () => {
    repository.findById.mockResolvedValue(wallet({ frozenAt: FROZEN_AT, frozenReason: 'Fraud review' }));

    await expect(move(movement('250.00'))).resolves.toMatchObject({ created: true });
    expect(repository.move).toHaveBeenCalled();
  });

  it('leaves an unfrozen wallet alone in both directions', async () => {
    await expect(move(movement('-250.00'))).resolves.toMatchObject({ created: true });
    await expect(move(movement('250.00'))).resolves.toMatchObject({ created: true });
  });

  /* Lot A (Q21): the closure freezes the wallet before it raises the final
     payout, so that one debit is let past the early check — the repository
     repeats the check on the row itself and honours the same flag. */
  it('lets a debit marked allowFrozen past the early check', async () => {
    repository.findById.mockResolvedValue(wallet({ frozenAt: FROZEN_AT, frozenReason: 'Account closed' }));

    await expect(move({ ...movement('-250.00'), allowFrozen: true })).resolves.toMatchObject({ created: true });
    expect(repository.move).toHaveBeenCalledWith(expect.objectContaining({ allowFrozen: true }));
  });

  it('still refuses a movement for nothing', async () => {
    await expect(move(movement('0.00'))).rejects.toMatchObject({ statusCode: 500 });
  });
});
