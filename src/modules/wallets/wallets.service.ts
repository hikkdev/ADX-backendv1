import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { ensureAccounts } from '../ledger';
import { prismaWalletsRepository as repository } from './prisma-wallets.repository';
import type { MovementInput, WalletOwner, WalletOwnerKind } from './wallets.repository';

/**
 * What a party's wallet holds, and how money gets into and out of it.
 *
 * The numbers a screen shows are all derived rather than stored, so they cannot
 * drift from the entries behind them:
 *
 *   balance            settled money, credits less debits
 *   goodwill           credit that can be spent and never withdrawn
 *   pendingClearance   earned, credited, still inside its clearing window
 *   held               reserved against a booking
 *   openWithdrawals    reserved: asked for or approved, and not yet released
 *                      (Lot B, Q140 — a released line has already left the balance)
 *   withdrawable       balance − pendingClearance − held − openWithdrawals
 *
 * `withdrawable` is the only one that needed a decision, and it follows from
 * the accrual rule: money lands the day it is earned, and waits out its hold
 * before it can leave.
 */

export type WalletSnapshot = {
  walletId: string;
  balance: Money;
  goodwill: Money;
  /** Spendable on the platform: settled balance plus goodwill, less what is held or reserved for a withdrawal. */
  spendable: Money;
  pendingClearance: Money;
  held: Money;
  openWithdrawals: Money;
  /** What a withdrawal may draw on right now. Never negative. */
  withdrawable: Money;
  lastActivityAt: Date | null;
  /** Lot A: set while FREEZE_WALLET is on the party. Money lands; nothing leaves. */
  frozenAt: Date | null;
  frozenReason: string | null;
};

export async function ensureWallet(owner: WalletOwner, label: string) {
  await ensureAccounts();
  return repository.ensure(owner, label);
}

export const findWallet = (walletId: string) => repository.findById(walletId);
export const findWalletFor = (owner: WalletOwner) => repository.findByOwner(owner);

export async function snapshot(walletId: string, now = new Date()): Promise<WalletSnapshot> {
  const row = await repository.snapshot(walletId, now);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');

  const balance = new Decimal(row.wallet.balance);
  const goodwill = new Decimal(row.wallet.goodwill);
  const held = new Decimal(row.held);
  const open = new Decimal(row.openWithdrawals);
  const pending = new Decimal(row.pendingClearance);

  const withdrawable = balance.minus(pending).minus(held).minus(open);

  return {
    walletId: row.wallet.id,
    balance: money(balance),
    goodwill: money(goodwill),
    spendable: money(Decimal.max(balance.plus(goodwill).minus(held).minus(open), new Decimal(0))),
    pendingClearance: money(pending),
    held: money(held),
    openWithdrawals: money(open),
    // Clamped: a wallet whose holds exceed its balance owes nothing, it simply
    // cannot withdraw. A negative here would read as a debt on screen.
    withdrawable: money(Decimal.max(withdrawable, new Decimal(0))),
    lastActivityAt: row.wallet.lastActivityAt,
    frozenAt: row.wallet.frozenAt ?? null,
    frozenReason: row.wallet.frozenReason ?? null,
  };
}

/**
 * Moves money, and refuses rather than half-moving it.
 *
 * Null comes back only when the wallet is gone; every other failure throws,
 * because a caller that silently ignored a failed credit would leave a party
 * unpaid with nothing to show for it.
 *
 * Lot B: this is also the advertiser side's one door. A top-up, a hold
 * capture, a package debit, a goodwill credit, a refund and an expiry all
 * come through here with their counter-legs, so the freeze check and the
 * double-entry twin are one path rather than two things a caller can forget
 * separately. `spendGoodwillFirst`, `captureHoldId` and `requireFunds` are the
 * three things that path needed and the publisher side did not.
 */
export async function move(input: MovementInput) {
  await ensureAccounts();
  const amount = new Decimal(input.amount);
  if (amount.isZero()) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'A wallet movement cannot be for nothing');
  }
  // Lot A FREEZE_WALLET: a debit from a frozen wallet is refused; a credit —
  // an accrual, an incentive, a refund landing — still goes through, so the
  // books stay true and only money leaving is stopped.
  //
  // This read is the cheap early answer; the one that counts is repeated
  // inside the repository's transaction, on the row about to be written, so
  // a freeze that lands between here and there still refuses the debit.
  // `allowFrozen` is Lot A (Q21): the closure's own final payout, and nothing else.
  if (amount.isNegative() && !input.allowFrozen) {
    const wallet = await repository.findById(input.walletId);
    if (!wallet) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
    if (wallet.frozenAt) {
      throw new ApiError(409, 'WALLET_FROZEN', 'This wallet is frozen; money cannot leave it', {
        walletId: wallet.id,
        frozenAt: wallet.frozenAt,
        reason: wallet.frozenReason,
      });
    }
  }
  const result = await repository.move(input);
  if (!result) throw new ApiError(404, 'NOT_FOUND', 'Wallet not found');
  return result;
}

export const listEntries = (
  walletId: string,
  filter: Parameters<typeof repository.listEntries>[1]
) => repository.listEntries(walletId, filter);

/**
 * Lot A FREEZE_WALLET. Idempotent: freezing a frozen wallet refreshes the
 * reason and the stamp; thawing an open wallet is a no-op. Both answer null
 * for a wallet that does not exist, so a party who never earned anything can
 * still be suspended without a wallet being conjured for the purpose.
 */
export async function freezeWallet(
  owner: WalletOwner,
  input: { reason: string; byUserId: string | null; at?: Date }
) {
  const wallet = await repository.findByOwner(owner);
  if (!wallet) return null;
  return repository.freeze(wallet.id, { reason: input.reason, byUserId: input.byUserId, at: input.at ?? new Date() });
}

export async function unfreezeWallet(owner: WalletOwner) {
  const wallet = await repository.findByOwner(owner);
  if (!wallet) return null;
  if (!wallet.frozenAt) return wallet;
  return repository.unfreeze(wallet.id);
}

/** Whether the party's wallet is frozen. False when there is no wallet. */
export async function isWalletFrozen(owner: WalletOwner): Promise<boolean> {
  const wallet = await repository.findByOwner(owner);
  return Boolean(wallet?.frozenAt);
}

export const sumEntries = repository.sumEntries;
export const listWallets = (filter: { kind?: WalletOwnerKind; limit?: number }) =>
  repository.listWallets({ ...filter, limit: Math.min(filter.limit ?? 50, 200) });
