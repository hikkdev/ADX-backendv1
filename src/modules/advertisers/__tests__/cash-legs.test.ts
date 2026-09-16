import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot B (Q30/Q36): the cash side of an advertiser wallet balances.
 *
 * Before this, an advertiser top-up, capture or refund moved the wallet and
 * wrote its statement line and nothing else — `verifyLedger` covered
 * publishers and agents and was blind to the demand side. Now every one of
 * those is a `wallets.move` with its counter-legs, and this proves it the way
 * the reconciliation screen will: run a top-up, a capture and a refund through
 * the real services against an in-memory store, then ask `verifyLedger` — the
 * ledger service over the same repository port its own tests mock — whether
 * every transaction sums to zero and whether the wallet's balance + goodwill
 * equals the sum of its ledger legs.
 */

type Row = Record<string, any>;

const store = vi.hoisted(() => {
  const state = {
    wallets: new Map<string, Row>(),
    entries: [] as Row[],
    holds: new Map<string, Row>(),
    accounts: new Map<string, Row>(),
    transactions: [] as Row[],
    legs: [] as Row[],
    seq: 0,
  };
  const id = (prefix: string) => `${prefix}_${(state.seq += 1)}`;
  const D = (v: unknown) => new Decimal(v as string);

  const tx = {
    // Lot J2 (g): `move` takes a per-wallet advisory lock first; the in-memory store has nothing to lock.
    $executeRaw: async () => 0,
    wallet: {
      findUnique: async ({ where }: Row) => state.wallets.get(where.id) ?? null,
      update: async ({ where, data }: Row) => {
        const row = state.wallets.get(where.id)!;
        for (const field of ['balance', 'goodwill'] as const) {
          const change = data[field];
          if (!change) continue;
          row[field] = D(row[field]).plus(change.increment ?? 0).minus(change.decrement ?? 0);
        }
        return { ...row };
      },
    },
    walletEntry: {
      create: async ({ data }: Row) => {
        const row = { id: id('ent'), isGoodwill: false, ...data, createdAt: new Date() };
        state.entries.push(row);
        return row;
      },
      findMany: async () => [],
    },
    walletHold: {
      findUnique: async ({ where }: Row) => state.holds.get(where.id) ?? null,
      update: async ({ where, data }: Row) => Object.assign(state.holds.get(where.id)!, data),
      aggregate: async ({ where }: Row) => {
        const open = [...state.holds.values()].filter((h) => h.walletId === where.walletId && h.status === 'HELD');
        return { _sum: { amount: open.reduce((sum, h) => sum.plus(h.amount), new Decimal(0)) } };
      },
    },
    ledgerAccount: {
      findUnique: async ({ where }: Row) =>
        [...state.accounts.values()].find((a) => (where.code ? a.code === where.code : a.walletId === where.walletId)) ?? null,
      create: async ({ data }: Row) => {
        const row = { id: id('acc'), walletId: null, ...data };
        state.accounts.set(row.id, row);
        return row;
      },
    },
    ledgerTransaction: {
      findUnique: async ({ where }: Row) => state.transactions.find((t) => t.idempotencyKey === where.idempotencyKey) ?? null,
      count: async ({ where }: Row) =>
        where?.reference ? state.transactions.filter((t) => t.reference === where.reference).length : state.transactions.length,
      create: async ({ data }: Row) => {
        const row = { id: id('ltx'), ...data };
        state.transactions.push(row);
        return row;
      },
    },
    ledgerLeg: {
      create: async ({ data }: Row) => {
        const row = { id: id('leg'), ...data, amount: D(data.amount) };
        state.legs.push(row);
        return row;
      },
    },
  };

  /* The ledger's own repository port, answered from the same store — the
     shape ledger.test.ts mocks, with the two proofs computed for real. */
  const ledgerRepository = {
    findAccountByCode: async (code: string) => tx.ledgerAccount.findUnique({ where: { code } }),
    findAccountByWallet: async (walletId: string) => tx.ledgerAccount.findUnique({ where: { walletId } }),
    createAccount: async (data: Row) => tx.ledgerAccount.create({ data }),
    listAccounts: async () => [...state.accounts.values()],
    append: vi.fn(),
    findTransaction: vi.fn(),
    findTransactionByKey: vi.fn(),
    listTransactions: vi.fn(),
    referenceExists: vi.fn(),
    countForYear: vi.fn(),
    balanceOf: async (accountId: string) =>
      state.legs.filter((l) => l.accountId === accountId).reduce((sum, l) => sum.plus(l.amount), new Decimal(0)),
    findUnbalanced: async () =>
      state.transactions
        .map((t) => ({
          transactionId: t.id,
          total: state.legs.filter((l) => l.transactionId === t.id).reduce((sum, l) => sum.plus(l.amount), new Decimal(0)),
        }))
        .filter((row) => !row.total.isZero()),
    findWalletDrift: async () =>
      [...state.wallets.values()]
        .map((w) => {
          const account = [...state.accounts.values()].find((a) => a.walletId === w.id);
          const ledgerTotal: Decimal = account
            ? state.legs.filter((l) => l.accountId === account.id).reduce((sum: Decimal, l) => sum.plus(D(l.amount)), new Decimal(0))
            : new Decimal(0);
          const walletTotal: Decimal = D(w.balance).plus(D(w.goodwill));
          return { walletId: w.id, walletTotal, ledgerTotal };
        })
        .filter((row) => !row.walletTotal.equals(row.ledgerTotal)),
  };

  return {
    state,
    tx,
    ledgerRepository,
    // The reads the services make outside a transaction go to the same store.
    prisma: { ...tx, $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) },
  };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma: store.prisma };
});
vi.mock('../../ledger/prisma-ledger.repository', () => ({ prismaLedgerRepository: store.ledgerRepository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../payouts', () => ({ findPayoutMethod: vi.fn() }));

const advertisersRepository = vi.hoisted(() => ({
  findAdvertiserById: vi.fn(),
  ensureWallet: vi.fn(),
  walletSnapshot: vi.fn(),
  findHoldById: vi.fn(),
  createTopUp: vi.fn(),
  findTopUpByPayment: vi.fn(),
}));
vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: advertisersRepository }));

import { resetAccountCache, verifyLedger, walletBalance } from '../../ledger';
import { captureCampaignHold, creditCampaignRefund, topUp } from '../advertisers.service';

const NOW = new Date('2026-09-12T10:00:00Z');
const advertiser = { id: 'adv_1', name: 'Nilgiri Coffee', companyName: null, userId: 'usr_adv' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  resetAccountCache();
  const { state } = store;
  state.wallets.clear();
  state.entries.length = 0;
  state.holds.clear();
  state.accounts.clear();
  state.transactions.length = 0;
  state.legs.length = 0;
  state.wallets.set('wal_1', {
    id: 'wal_1',
    advertiserId: 'adv_1',
    balance: new Decimal(0),
    goodwill: new Decimal(0),
    frozenAt: null,
    frozenReason: null,
  });
  advertisersRepository.findAdvertiserById.mockResolvedValue(advertiser);
  advertisersRepository.ensureWallet.mockImplementation(async () => store.state.wallets.get('wal_1'));
  advertisersRepository.walletSnapshot.mockImplementation(async () => {
    const w = store.state.wallets.get('wal_1')!;
    return { balance: w.balance.toFixed(2), goodwill: w.goodwill.toFixed(2), held: '0.00', spendable: w.balance.toFixed(2), currency: 'INR' };
  });
  advertisersRepository.findHoldById.mockImplementation(async (id: string) => store.state.holds.get(id) ?? null);
  advertisersRepository.createTopUp.mockImplementation(async (data: Row) => ({ id: 'tup_1', ...data }));
});

describe('the books balance across the advertiser money path', () => {
  it('top-up, capture and refund each land with their twin, and verifyLedger stays healthy', async () => {
    // 1. Ops records a ₹30,000 bank transfer. Wallet +, suspense −.
    await topUp(
      'adv_1',
      { amount: '30000.00', method: 'BANK_TRANSFER', utr: 'UTR-1', receivedAt: NOW },
      'usr_ops'
    );
    expect(store.state.wallets.get('wal_1')!.balance.toFixed(2)).toBe('30000.00');

    // 2. A ₹20,000 campaign is confirmed and starts. Wallet −, payables +.
    store.state.holds.set('hld_1', {
      id: 'hld_1',
      walletId: 'wal_1',
      campaignId: 'cmp_1',
      amount: new Decimal('20000.00'),
      status: 'HELD',
    });
    await captureCampaignHold('hld_1');
    expect(store.state.holds.get('hld_1')!.status).toBe('CAPTURED');
    expect(store.state.wallets.get('wal_1')!.balance.toFixed(2)).toBe('10000.00');

    // 3. The campaign is cancelled with ₹8,000 unused; finance releases it.
    //    Wallet +, payables −.
    await creditCampaignRefund({
      advertiserId: 'adv_1',
      campaignId: 'cmp_1',
      campaignRefundId: 'cref_1',
      amount: '8000.00',
      note: 'Refund for CMP-1',
      byUserId: 'usr_finance',
    });
    expect(store.state.wallets.get('wal_1')!.balance.toFixed(2)).toBe('18000.00');

    // Three movements, three balanced transactions, and the wallet's own
    // statement agrees with its ledger account to the paisa.
    expect(store.state.transactions.map((t) => t.kind)).toEqual(['TOPUP', 'CAMPAIGN_SPEND', 'REFUND']);
    expect(store.state.entries.map((e) => [e.type, e.amount.toFixed(2)])).toEqual([
      ['TOPUP', '30000.00'],
      ['CAMPAIGN_DEBIT', '-20000.00'],
      ['REFUND', '8000.00'],
    ]);

    const proof = await verifyLedger();
    expect(proof).toEqual({ unbalanced: [], drift: [], healthy: true });
    expect(await walletBalance('wal_1')).toBe('18000.00');

    // ADX's side reads the way a reconciliation screen expects: ₹30,000 still
    // in suspense until the bank line is matched, ₹12,000 owed to publishers.
    const balanceOf = async (code: string) => {
      const account = [...store.state.accounts.values()].find((a) => a.code === code)!;
      return (await store.ledgerRepository.balanceOf(account.id)).toFixed(2);
    };
    expect(await balanceOf('platform:suspense')).toBe('-30000.00');
    expect(await balanceOf('platform:payables')).toBe('12000.00');
  });

  /* A replayed capture — the transitions job running twice in a minute — is
     one movement. The key is the hold, so the second attempt finds the first. */
  it('does not double a capture that is replayed', async () => {
    await topUp('adv_1', { amount: '5000.00', method: 'CHEQUE', utr: 'CHQ-9', receivedAt: NOW }, 'usr_ops');
    store.state.holds.set('hld_2', { id: 'hld_2', walletId: 'wal_1', campaignId: 'cmp_2', amount: new Decimal('5000.00'), status: 'HELD' });

    await captureCampaignHold('hld_2');
    await captureCampaignHold('hld_2');

    expect(store.state.wallets.get('wal_1')!.balance.toFixed(2)).toBe('0.00');
    expect(store.state.transactions).toHaveLength(2);
    expect((await verifyLedger()).healthy).toBe(true);
  });

  /* Goodwill is part of what the wallet holds, and the books see it: the
     drift check compares balance + goodwill with the account, so a capture
     that spends goodwill first must still reconcile. */
  it('keeps goodwill inside the proof when a capture spends it first', async () => {
    const { creditGoodwill } = await import('../advertisers.service');
    await topUp('adv_1', { amount: '1000.00', method: 'BANK_TRANSFER', utr: 'UTR-2', receivedAt: NOW }, 'usr_ops');
    await creditGoodwill('adv_1', '500.00', null, 'Sorry about the hoarding', { idempotencyKey: 'goodwill:test' });
    store.state.holds.set('hld_3', { id: 'hld_3', walletId: 'wal_1', campaignId: 'cmp_3', amount: new Decimal('1200.00'), status: 'HELD' });

    await captureCampaignHold('hld_3');

    const wallet = store.state.wallets.get('wal_1')!;
    expect(wallet.goodwill.toFixed(2)).toBe('0.00');
    expect(wallet.balance.toFixed(2)).toBe('300.00');
    expect(store.state.entries.filter((e) => e.type === 'CAMPAIGN_DEBIT').map((e) => [e.isGoodwill, e.amount.toFixed(2)])).toEqual([
      [true, '-500.00'],
      [false, '-700.00'],
    ]);
    expect((await verifyLedger()).healthy).toBe(true);
  });
});
