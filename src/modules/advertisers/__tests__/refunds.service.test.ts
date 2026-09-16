import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The refund desk on the wallet side — Lot B (Q41) over the DR 03 rules.
 *
 * What was already true stays true: support raises, a different admin
 * decides, the cap is what was paid in. What Lot B adds is a destination.
 * Credit left in the wallet needs nothing more; cash out needs the
 * advertiser's recorded consent and, for a bank transfer, a VERIFIED method
 * of their own. A bank transfer then walks APPROVED → PAID (or FAILED) with
 * the ledger legs each step implies.
 */

const { repository, wallets, ledger, payouts } = vi.hoisted(() => ({
  repository: {
    findAdvertiserById: vi.fn(),
    findOpenRefundRequest: vi.fn(),
    refundableAmount: vi.fn(),
    createRefundRequest: vi.fn(),
    findRefundRequest: vi.fn(),
    decideRefundRequest: vi.fn(),
    updateRefundRequest: vi.fn(),
    withdrawRefundRequest: vi.fn(),
    findDormantWallets: vi.fn(),
    highestTemplateVersion: vi.fn(),
    deactivateTemplates: vi.fn(),
    createTemplate: vi.fn(),
    ensureWallet: vi.fn(),
    createTopUp: vi.fn(),
    findTopUpByPayment: vi.fn(),
    walletSnapshot: vi.fn(),
  },
  wallets: { move: vi.fn(), findWallet: vi.fn() },
  ledger: { platformAccount: vi.fn(), post: vi.fn() },
  payouts: { findPayoutMethod: vi.fn() },
}));

vi.mock('../prisma-advertisers.repository', () => ({
  prismaAdvertisersRepository: repository,
}));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../ledger', () => ledger);
vi.mock('../../payouts', () => payouts);

import {
  CREDIT_DORMANCY_MONTHS,
  decideRefund,
  expireDormantCredit,
  failRefund,
  markRefundPaid,
  registerOriginalMethodRefundPort,
  requestRefund,
  topUp,
  withdrawRefund,
} from '../advertisers.service';

const advertiser = { id: 'adv-1', name: 'Nilgiri Coffee', userId: 'usr-adv' } as never;
const NOW = new Date('2026-09-12T10:00:00Z');

const input = {
  amount: '50000.00',
  reason: 'ADVERTISER_LEAVING' as const,
  note: 'Closing the account, unspent top-up left over.',
};

const request = (over: Record<string, unknown> = {}) => ({
  id: 'ref-1',
  walletId: 'wal-1',
  amount: '50000.00',
  status: 'PENDING',
  raisedByUserId: 'usr-support',
  destination: 'WALLET_CREDIT',
  holdId: 'hld-r1',
  note: input.note,
  decisionNote: null,
  rail: null,
  ledgerTransactionId: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAdvertiserById.mockResolvedValue(advertiser);
  repository.findOpenRefundRequest.mockResolvedValue(null);
  repository.refundableAmount.mockResolvedValue('80000.00');
  repository.createRefundRequest.mockResolvedValue({ id: 'ref-1', status: 'PENDING' });
  repository.decideRefundRequest.mockImplementation(async (arg: Record<string, unknown>) => request({ status: arg['status'], ledgerTransactionId: arg['ledgerTransactionId'] ?? null }));
  // T-B: the update answers the desk's row — the request with its advertiser.
  repository.updateRefundRequest.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...request(patch),
    advertiser: { id: 'adv-1', displayId: 'ADV-0001', name: 'Anita' },
  }));
  repository.ensureWallet.mockResolvedValue({ id: 'wal-1', advertiserId: 'adv-1' });
  repository.walletSnapshot.mockResolvedValue({ balance: '50000.00', goodwill: '0.00', held: '0.00', spendable: '50000.00', currency: 'INR' });
  wallets.findWallet.mockResolvedValue({ id: 'wal-1', advertiserId: 'adv-1' });
  wallets.move.mockResolvedValue({ wallet: {}, entry: { id: 'ent-1' }, entries: [], ledgerTransactionId: 'ltx-1', created: true });
  ledger.platformAccount.mockImplementation(async (code: string) => ({ id: `acc_${code}` }));
  ledger.post.mockResolvedValue({ transaction: { id: 'ltx-paid' }, created: true });
  payouts.findPayoutMethod.mockResolvedValue({ id: 'pm-1', userId: 'usr-adv', status: 'VERIFIED' });
});

describe('requestRefund', () => {
  it('raises the request against the wallet, as wallet credit by default', async () => {
    await requestRefund('adv-1', input, 'usr-support');

    expect(repository.createRefundRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        advertiserId: 'adv-1',
        amount: '50000.00',
        reason: 'ADVERTISER_LEAVING',
        raisedByUserId: 'usr-support',
        destination: 'WALLET_CREDIT',
        consentNote: null,
        payoutMethodId: null,
      })
    );
  });

  /* The consumer-protection line: ADX may prefer credit, but may not impose
     it — and may not send cash without the advertiser having asked for it. */
  it('refuses a cash refund without the advertiser’s recorded consent', async () => {
    await expect(
      requestRefund('adv-1', { ...input, destination: 'BANK_TRANSFER', payoutMethodId: 'pm-1' }, 'usr-support')
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(repository.createRefundRequest).not.toHaveBeenCalled();
  });

  it('sends a bank transfer only to a VERIFIED method the advertiser owns', async () => {
    payouts.findPayoutMethod.mockResolvedValue({ id: 'pm-1', userId: 'usr-someone-else', status: 'VERIFIED' });
    await expect(
      requestRefund('adv-1', { ...input, destination: 'BANK_TRANSFER', payoutMethodId: 'pm-1', consentNote: 'Asked on ticket TKT-1' }, 'usr-support')
    ).rejects.toMatchObject({ statusCode: 404 });

    payouts.findPayoutMethod.mockResolvedValue({ id: 'pm-1', userId: 'usr-adv', status: 'PENDING_VERIFICATION' });
    await expect(
      requestRefund('adv-1', { ...input, destination: 'BANK_TRANSFER', payoutMethodId: 'pm-1', consentNote: 'Asked on ticket TKT-1' }, 'usr-support')
    ).rejects.toMatchObject({ statusCode: 400 });

    payouts.findPayoutMethod.mockResolvedValue({ id: 'pm-1', userId: 'usr-adv', status: 'VERIFIED' });
    await requestRefund('adv-1', { ...input, destination: 'BANK_TRANSFER', payoutMethodId: 'pm-1', consentNote: 'Asked on ticket TKT-1' }, 'usr-support');
    expect(repository.createRefundRequest).toHaveBeenCalledWith(
      expect.objectContaining({ destination: 'BANK_TRANSFER', payoutMethodId: 'pm-1', consentNote: 'Asked on ticket TKT-1' })
    );
  });

  /* Lot C (Q110): ORIGINAL_METHOD is `payments`' answer through the port —
     no port, or no captured gateway payment to return to, and it is refused. */
  it('refuses ORIGINAL_METHOD with 409 GATEWAY_NOT_CONFIGURED while nothing can return it', async () => {
    registerOriginalMethodRefundPort(null);
    await expect(
      requestRefund('adv-1', { ...input, destination: 'ORIGINAL_METHOD', consentNote: 'Asked on ticket TKT-1' }, 'usr-support')
    ).rejects.toMatchObject({ statusCode: 409, code: 'GATEWAY_NOT_CONFIGURED' });

    const refundable = vi.fn(async () => false);
    registerOriginalMethodRefundPort({ refundable });
    await expect(
      requestRefund('adv-1', { ...input, destination: 'ORIGINAL_METHOD', consentNote: 'Asked on ticket TKT-1' }, 'usr-support')
    ).rejects.toMatchObject({ statusCode: 409, code: 'GATEWAY_NOT_CONFIGURED' });
    expect(refundable).toHaveBeenCalledWith('adv-1', '50000.00');
    registerOriginalMethodRefundPort(null);
  });

  it('raises ORIGINAL_METHOD when the gateway can take it back', async () => {
    registerOriginalMethodRefundPort({ refundable: vi.fn(async () => true) });
    await requestRefund('adv-1', { ...input, destination: 'ORIGINAL_METHOD', consentNote: 'Asked on ticket TKT-1' }, 'usr-support');
    expect(repository.createRefundRequest).toHaveBeenCalledWith(
      expect.objectContaining({ destination: 'ORIGINAL_METHOD', consentNote: 'Asked on ticket TKT-1' })
    );
    registerOriginalMethodRefundPort(null);
  });

  it('refuses a second open request on the same wallet', async () => {
    repository.findOpenRefundRequest.mockResolvedValue({ id: 'ref-0' });

    await expect(requestRefund('adv-1', input, 'usr-support')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(repository.createRefundRequest).not.toHaveBeenCalled();
  });

  it('refuses more than the refundable cap', async () => {
    repository.refundableAmount.mockResolvedValue('20000.00');

    await expect(requestRefund('adv-1', input, 'usr-support')).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(repository.createRefundRequest).not.toHaveBeenCalled();
  });

  it('allows exactly the cap', async () => {
    repository.refundableAmount.mockResolvedValue('50000.00');

    await expect(requestRefund('adv-1', input, 'usr-support')).resolves.toMatchObject({
      id: 'ref-1',
    });
  });

  it('rejects a zero amount', async () => {
    await expect(
      requestRefund('adv-1', { ...input, amount: '0.00' }, 'usr-support')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('reports a wallet that moved underneath it as a funds problem', async () => {
    repository.createRefundRequest.mockResolvedValue(null);

    await expect(requestRefund('adv-1', input, 'usr-support')).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
  });
});

describe('decideRefund', () => {
  beforeEach(() => {
    repository.findRefundRequest.mockResolvedValue(request());
  });

  it('refuses a decision from whoever raised it', async () => {
    await expect(decideRefund('ref-1', true, 'usr-support')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(repository.decideRefundRequest).not.toHaveBeenCalled();
    expect(wallets.move).not.toHaveBeenCalled();
  });

  /* Credit left in the wallet: nothing leaves, the frozen slice is released
     back to spendable balance, and the request records that ADX answered
     with credit. */
  it('approves wallet credit by releasing the hold and moving nothing', async () => {
    await decideRefund('ref-1', true, 'usr-admin', 'Credit stays on the account');

    expect(wallets.move).not.toHaveBeenCalled();
    expect(repository.decideRefundRequest).toHaveBeenCalledWith({
      requestId: 'ref-1',
      status: 'APPROVED',
      hold: 'RELEASE',
      decidedByUserId: 'usr-admin',
      decisionNote: 'Credit stays on the account',
    });
  });

  it('rejects by releasing the hold', async () => {
    await decideRefund('ref-1', false, 'usr-admin', 'Not refundable');
    expect(repository.decideRefundRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'REJECTED', hold: 'RELEASE' })
    );
    expect(wallets.move).not.toHaveBeenCalled();
  });

  /* Lot A verifier (a): the approval used to decrement the balance straight
     through Prisma, past the freeze. Now it is a movement — the hold is
     captured as the REFUND debit, the legs go to payables, and a frozen
     wallet refuses it where every other debit is refused. */
  it('approves a bank transfer as a REFUND debit through the wallets service, owed in payables', async () => {
    repository.findRefundRequest.mockResolvedValue(request({ destination: 'BANK_TRANSFER', payoutMethodId: 'pm-1' }));

    const decided = await decideRefund('ref-1', true, 'usr-admin', 'Verified, refunding to bank');

    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal-1',
        amount: '-50000.00',
        entryType: 'REFUND',
        ledgerKind: 'REFUND',
        idempotencyKey: 'refund:ref-1',
        captureHoldId: 'hld-r1',
        counterLegs: [expect.objectContaining({ accountCode: 'platform:payables', amount: '50000.00' })],
        createdByUserId: 'usr-admin',
      })
    );
    expect(repository.decideRefundRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'APPROVED', hold: 'LEAVE', ledgerTransactionId: 'ltx-1' })
    );
    expect(decided.status).toBe('APPROVED');
  });

  it('lets the wallets service refuse a frozen wallet, and decides nothing', async () => {
    repository.findRefundRequest.mockResolvedValue(request({ destination: 'BANK_TRANSFER' }));
    wallets.move.mockRejectedValue(Object.assign(new Error('frozen'), { statusCode: 409, code: 'WALLET_FROZEN' }));

    await expect(decideRefund('ref-1', true, 'usr-admin')).rejects.toMatchObject({ code: 'WALLET_FROZEN' });
    expect(repository.decideRefundRequest).not.toHaveBeenCalled();
  });

  it('refuses to decide an already-decided request', async () => {
    repository.findRefundRequest.mockResolvedValue(request({ status: 'APPROVED' }));

    await expect(decideRefund('ref-1', false, 'usr-admin')).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('404s an unknown request', async () => {
    repository.findRefundRequest.mockResolvedValue(null);

    await expect(decideRefund('nope', true, 'usr-admin')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('paying a bank-transfer refund', () => {
  beforeEach(() => {
    repository.findRefundRequest.mockResolvedValue(
      request({ status: 'APPROVED', destination: 'BANK_TRANSFER', ledgerTransactionId: 'ltx-1' })
    );
  });

  /* Cash enters the books here: payables discharged, cash credited, no
     wallet leg because the wallet was debited at approval. */
  it('marks it PAID with the UTR and posts payables − / cash +', async () => {
    const paid = await markRefundPaid('ref-1', { railReference: 'UTR123', byUserId: 'usr-finance' }, NOW);

    expect(ledger.post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'REFUND',
        idempotencyKey: 'refund-paid:ref-1',
        legs: [
          expect.objectContaining({ accountId: 'acc_platform:payables', amount: '-50000.00' }),
          expect.objectContaining({ accountId: 'acc_platform:cash', amount: '50000.00' }),
        ],
      }),
      NOW
    );
    expect(wallets.move).not.toHaveBeenCalled();
    expect(repository.updateRefundRequest).toHaveBeenCalledWith('ref-1', {
      status: 'PAID',
      paidAt: NOW,
      paidByUserId: 'usr-finance',
      rail: 'MANUAL_NEFT',
      railReference: 'UTR123',
      ledgerTransactionId: 'ltx-1',
    });
    expect(paid.status).toBe('PAID');
    // T-B: the answer is the desk's row — the advertiser rides beside the request
    expect(paid.advertiser).toEqual({ id: 'adv-1', displayId: 'ADV-0001', name: 'Anita' });
  });

  it('will not mark a payment made without its transfer reference', async () => {
    await expect(markRefundPaid('ref-1', { railReference: '  ', byUserId: 'a' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('only pays an APPROVED bank transfer', async () => {
    repository.findRefundRequest.mockResolvedValue(request({ status: 'APPROVED', destination: 'WALLET_CREDIT' }));
    await expect(markRefundPaid('ref-1', { railReference: 'UTR1', byUserId: 'a' })).rejects.toMatchObject({ statusCode: 409 });
    repository.findRefundRequest.mockResolvedValue(request({ status: 'PENDING', destination: 'BANK_TRANSFER' }));
    await expect(markRefundPaid('ref-1', { railReference: 'UTR1', byUserId: 'a' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('is a no-op the second time', async () => {
    repository.findRefundRequest.mockResolvedValue(request({ status: 'PAID', destination: 'BANK_TRANSFER' }));
    await markRefundPaid('ref-1', { railReference: 'UTR1', byUserId: 'a' });
    expect(ledger.post).not.toHaveBeenCalled();
  });

  /* The transfer bounced: the approval's debit stays on the record and a
     fresh movement returns the money — wallet + / payables −. As a REFUND
     credit, so the paid-in cap counts it back in. */
  it('fails it by returning the money to the wallet and reversing the payables leg', async () => {
    const failed = await failRefund('ref-1', { reason: 'Account closed at the bank', byUserId: 'usr-finance' }, NOW);

    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal-1',
        amount: '50000.00',
        entryType: 'REFUND',
        ledgerKind: 'ADJUSTMENT',
        idempotencyKey: 'refund-failed:ref-1',
        counterLegs: [expect.objectContaining({ accountCode: 'platform:payables', amount: '-50000.00' })],
      })
    );
    expect(repository.updateRefundRequest).toHaveBeenCalledWith(
      'ref-1',
      expect.objectContaining({ status: 'FAILED', decisionNote: 'Failed: Account closed at the bank' })
    );
    expect(failed.status).toBe('FAILED');
    // T-B: the desk's row on the fail too
    expect(failed.advertiser).toEqual({ id: 'adv-1', displayId: 'ADV-0001', name: 'Anita' });
  });

  it('needs a reason to fail', async () => {
    await expect(failRefund('ref-1', { reason: ' ', byUserId: 'a' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('withdrawRefund', () => {
  it('refuses anything that is not still open', async () => {
    repository.withdrawRefundRequest.mockResolvedValue(null);

    await expect(withdrawRefund('ref-1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('recording a top-up (Lot B, Q41/Q118)', () => {
  beforeEach(() => {
    repository.createTopUp.mockImplementation(async (data: Record<string, unknown>) => ({
      id: 'tup-1',
      ...data,
      receivedAt: data['receivedAt'],
    }));
  });

  const transfer = {
    amount: '25000.00',
    method: 'BANK_TRANSFER' as const,
    utr: 'HDFCN52026091212345',
    receivedAt: NOW,
    bankAccountId: 'adx-hdfc-current',
    proofFileId: 'file-1',
  };

  /* A transfer is a claim until the bank line is matched, so its twin is
     suspense — not cash. Keyed on the wallet and the UTR: a second entry of
     the same transfer is one top-up. */
  it('credits the wallet against suspense, keyed on the UTR, and records the row', async () => {
    const outcome = await topUp('adv-1', transfer, 'usr-ops');

    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal-1',
        amount: '25000.00',
        entryType: 'TOPUP',
        ledgerKind: 'TOPUP',
        idempotencyKey: 'topup:wal-1:bank_transfer:HDFCN52026091212345',
        counterLegs: [expect.objectContaining({ accountCode: 'platform:suspense', amount: '-25000.00' })],
        reference: 'HDFCN52026091212345',
        occurredAt: NOW,
        createdByUserId: 'usr-ops',
      })
    );
    expect(repository.createTopUp).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal-1',
        method: 'BANK_TRANSFER',
        utr: 'HDFCN52026091212345',
        bankAccountId: 'adx-hdfc-current',
        proofFileId: 'file-1',
        recordedByUserId: 'usr-ops',
        walletEntryId: 'ent-1',
        ledgerTransactionId: 'ltx-1',
        reconciledAt: null,
      })
    );
    expect(outcome.created).toBe(true);
  });

  it('refuses a bank transfer without its UTR', async () => {
    await expect(topUp('adv-1', { ...transfer, utr: undefined }, 'usr-ops')).rejects.toMatchObject({ statusCode: 400 });
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('tells the second person the same UTR was already recorded', async () => {
    wallets.move.mockResolvedValue({ wallet: {}, entry: null, entries: [], ledgerTransactionId: 'ltx-1', created: false });
    await expect(topUp('adv-1', transfer, 'usr-ops')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.createTopUp).not.toHaveBeenCalled();
  });

  /* The gateway's settlement is cash ADX holds, reconciled by the gateway
     itself; and its webhook retries are answered with the top-up already made. */
  it('books a gateway settlement against cash, reconciled at once, and answers a replay with the same row', async () => {
    const { recordGatewayTopUp } = await import('../advertisers.service');
    await recordGatewayTopUp('adv-1', { amount: '1000.00', paymentId: 'pay_ABC', receivedAt: NOW }, 'system');
    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'topup:gateway:pay_ABC',
        counterLegs: [expect.objectContaining({ accountCode: 'platform:cash', amount: '-1000.00' })],
      })
    );
    expect(repository.createTopUp).toHaveBeenCalledWith(expect.objectContaining({ method: 'GATEWAY', paymentId: 'pay_ABC', reconciledAt: NOW }));

    repository.createTopUp.mockClear();
    wallets.move.mockResolvedValue({ wallet: {}, entry: null, entries: [], ledgerTransactionId: 'ltx-1', created: false });
    repository.findTopUpByPayment.mockResolvedValue({ id: 'tup-1', paymentId: 'pay_ABC' });
    const replay = await recordGatewayTopUp('adv-1', { amount: '1000.00', paymentId: 'pay_ABC', receivedAt: NOW }, 'system');
    expect(replay.created).toBe(false);
    expect(replay.topUp.id).toBe('tup-1');
    expect(repository.createTopUp).not.toHaveBeenCalled();
  });
});

describe('expireDormantCredit', () => {
  it('sweeps wallets untouched for the dormancy window, goodwill first, as EXPIRY against revenue', async () => {
    repository.findDormantWallets.mockResolvedValue([
      { id: 'wal-1', advertiserId: 'adv-1', balance: '300.00', goodwill: '50.00' },
    ]);

    const result = await expireDormantCredit(new Date('2027-09-07T00:00:00.000Z'));

    const [cutoff] = repository.findDormantWallets.mock.calls[0] as [Date, number];
    expect(cutoff.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal-1',
        amount: '-350.00',
        entryType: 'EXPIRY',
        ledgerKind: 'EXPIRY',
        spendGoodwillFirst: true,
        idempotencyKey: 'expiry:wal-1:2027-09-07',
        counterLegs: [expect.objectContaining({ accountCode: 'platform:revenue', amount: '350.00' })],
      })
    );
    expect(result).toEqual({ expired: 1 });
  });

  /* A frozen wallet is under review; its credit waits rather than lapsing
     underneath it. */
  it('leaves a frozen wallet alone and carries on', async () => {
    repository.findDormantWallets.mockResolvedValue([
      { id: 'wal-frozen', advertiserId: 'adv-1', balance: '300.00', goodwill: '0.00' },
      { id: 'wal-2', advertiserId: 'adv-1', balance: '10.00', goodwill: '0.00' },
    ]);
    const { ApiError } = await import('../../../shared/errors');
    wallets.move
      .mockRejectedValueOnce(new ApiError(409, 'WALLET_FROZEN', 'frozen'))
      .mockResolvedValueOnce({ wallet: {}, entry: null, entries: [], ledgerTransactionId: 'ltx-2', created: true });

    await expect(expireDormantCredit(NOW)).resolves.toEqual({ expired: 1 });
  });

  it('measures the window in months, not a fixed number of days', () => {
    expect(CREDIT_DORMANCY_MONTHS).toBe(12);
  });
});

/* `publishTemplate` is retired (Lot D): the template lifecycle is `agreements`' alone. */
