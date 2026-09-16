import { describe, expect, it } from 'vitest';
import type { TransactionType, WalletEntry, WalletEntryType } from '../../../shared/database';
import { Decimal } from '../../../shared/money';
import { TO_ENTRY, asTransactionType, toEarning } from '../prisma-earnings.repository';

/**
 * The agent ledger moved from the `Transaction` table into the shared wallet.
 * The endpoint's response did not change, and these pin that: as long as the
 * vocabulary survives a round trip, the agent app cannot tell the difference.
 */

const ALL_TRANSACTION_TYPES: TransactionType[] = [
  'ORDER_COMPLETION',
  'BONUS',
  'REFERRAL',
  'PAYOUT',
  'ADJUSTMENT',
];

describe('transaction and wallet vocabularies', () => {
  it('round-trips every transaction type unchanged', () => {
    for (const type of ALL_TRANSACTION_TYPES) {
      expect(asTransactionType(TO_ENTRY[type])).toBe(type);
    }
  });

  it('maps each transaction type to a distinct entry type', () => {
    const mapped = ALL_TRANSACTION_TYPES.map((type) => TO_ENTRY[type]);
    expect(new Set(mapped).size).toBe(ALL_TRANSACTION_TYPES.length);
  });

  it('reports demand-side entries as adjustments rather than throwing', () => {
    // These should never reach an agent wallet, but an endpoint that dies on
    // unexpected data is worse than one that describes it plainly.
    const demandSide: WalletEntryType[] = [
      'TOPUP',
      'CAMPAIGN_DEBIT',
      'GOODWILL_CREDIT',
      'REFUND',
      'PENALTY',
    ];
    for (const type of demandSide) {
      expect(asTransactionType(type)).toBe('ADJUSTMENT');
    }
  });
});

/**
 * Money leaves this module as a decimal string, like every other amount on the
 * API.
 *
 * It used to leave as a JS number, because the module predates that rule. The
 * column is `Decimal(14,2)`; a binary float in the middle is how an agent's
 * balance arrives as 1249.9999999999998, and it is the same failure that put
 * `ratePerDay` on strings.
 */

const entry = (over: Partial<WalletEntry> = {}): WalletEntry =>
  ({
    id: 'we_1',
    walletId: 'wl_1',
    type: 'EARNING',
    amount: new Decimal('1500.00'),
    balanceAfter: new Decimal('1500.00'),
    isGoodwill: false,
    campaignId: null,
    orderId: 'or_1',
    holdId: null,
    reference: null,
    note: 'Hoarding install — Andheri West',
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    ...over,
  }) as WalletEntry;

describe('an amount on the wire', () => {
  it('is a string, not a number', () => {
    const mapped = toEarning(entry(), 'ag_1');
    expect(mapped.amount).toBe('1500.00');
    expect(typeof mapped.amount).toBe('string');
  });

  it('always carries two decimal places, so "1200" and "1200.5" cannot differ', () => {
    expect(toEarning(entry({ amount: new Decimal('1200') }), 'ag_1').amount).toBe('1200.00');
    expect(toEarning(entry({ amount: new Decimal('1200.5') }), 'ag_1').amount).toBe('1200.50');
  });

  it('keeps a payout signed', () => {
    expect(toEarning(entry({ amount: new Decimal('-2000'), type: 'PAYOUT' }), 'ag_1').amount).toBe(
      '-2000.00'
    );
  });

  /**
   * The reason for the change, stated as a case. A number cannot hold this:
   * `Number('99999999999999.99')` is 16 significant digits, past what a double
   * represents exactly, and comes back as 100000000000000.
   */
  it('survives an amount a double would round away', () => {
    const large = new Decimal('99999999999999.99');
    expect(toEarning(entry({ amount: large }), 'ag_1').amount).toBe('99999999999999.99');
    expect(String(Number('99999999999999.99'))).not.toBe('99999999999999.99');
  });

  it('reports the note the entry carries, and an empty string when it has none', () => {
    expect(toEarning(entry(), 'ag_1').title).toBe('Hoarding install — Andheri West');
    expect(toEarning(entry({ note: null }), 'ag_1').title).toBe('');
  });
});
