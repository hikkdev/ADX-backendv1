import { logger } from '../../shared/logging';
import type { Money } from '../../shared/money';
import type { PayoutMethod, PayoutRailName } from '../../shared/database';
import { getPlatformSettings } from '../app-config';

/**
 * How money actually leaves the platform.
 *
 * Behind an interface on purpose, and not because a second implementation is
 * imminent: the platform's payout path must not be tied to one vendor. Manual
 * NEFT is the first implementation and stays the fallback for every other one —
 * a rail that is refusing transfers is a rail finance can step around by making
 * the payment by hand and recording the UTR, without a deployment.
 *
 * Nothing here decides *whether* to pay. Approval is a person's job, always;
 * this only moves an approved payment and reports what happened.
 */

export type PayoutInstruction = {
  withdrawalId: string;
  reference: string;
  /** Net of tax — what should land in the account. */
  amount: Money;
  method: PayoutMethod;
  /** The party's name as it stands on their KYC record, for the rail's records. */
  beneficiaryName: string;
};

export type PayoutResult =
  | { status: 'PAID'; railReference: string }
  | { status: 'PROCESSING'; railReference: string }
  | { status: 'FAILED'; reason: string };

export interface PayoutRail {
  readonly name: PayoutRailName;
  /** False when the vendor is unconfigured, so the caller can fall back. */
  isConfigured(): boolean;
  /** True where the rail can send a rupee and match the name on the account. */
  supportsPennyDrop(): boolean;
  pay(instruction: PayoutInstruction): Promise<PayoutResult>;
  pennyDrop?(method: PayoutMethod): Promise<{ matched: boolean; name?: string; reference: string }>;
}

/**
 * Finance moves the money and records the UTR.
 *
 * Deliberately not a stub that pretends to pay: it returns PROCESSING and waits
 * for a human to confirm, which is exactly what happens in the world. A payout
 * marked paid by software that did not pay anything is the worst possible bug
 * in this domain.
 */
export const manualNeftRail: PayoutRail = {
  name: 'MANUAL_NEFT',
  isConfigured: () => true,
  supportsPennyDrop: () => false,
  async pay(instruction) {
    logger.info('Payout queued for manual transfer', {
      withdrawalId: instruction.withdrawalId,
      reference: instruction.reference,
      amount: instruction.amount,
    });
    // No railReference yet — finance supplies the UTR when the transfer is made.
    return { status: 'PROCESSING', railReference: '' };
  },
};

/**
 * A vendor that is registered and not configured.
 *
 * Both Razorpay X and Cashfree sit here until an account exists. They report
 * `isConfigured(): false`, so `railFor` skips them and the manual rail carries
 * the payment — which is the behaviour asked for: configurable, and never
 * dependent on one vendor being up.
 */
function unconfiguredVendor(name: PayoutRailName, envVar: string): PayoutRail {
  return {
    name,
    isConfigured: () => Boolean(process.env[envVar]),
    supportsPennyDrop: () => false,
    async pay() {
      return {
        status: 'FAILED',
        reason: `${name} is not configured. Set ${envVar}, or pay through the manual rail.`,
      };
    },
  };
}

export const razorpayXRail = unconfiguredVendor('RAZORPAY_X', 'RAZORPAY_X_KEY');
export const cashfreeRail = unconfiguredVendor('CASHFREE', 'CASHFREE_PAYOUT_KEY');

const RAILS: PayoutRail[] = [razorpayXRail, cashfreeRail, manualNeftRail];

/** The two settings `railFor` reads — `finance.*` on the platform settings row. */
export type RailSettings = {
  primaryRail: PayoutRailName;
  railFallbackOrder: readonly PayoutRailName[];
};

export const DEFAULT_RAIL_SETTINGS: RailSettings = {
  primaryRail: 'MANUAL_NEFT',
  railFallbackOrder: ['RAZORPAY_X', 'CASHFREE', 'MANUAL_NEFT'],
};

const byName = (name: PayoutRailName) => RAILS.find((rail) => rail.name === name);

/**
 * Which rail carries a payment, given the settings (Lot B, Q85).
 *
 * A named preference wins if it is configured; then the platform's one
 * primary rail; then the fallback order, each if configured; and manual is
 * always last and always available whatever the list says — so losing a
 * vendor degrades to a slower path rather than to an outage, and switching
 * vendor is a settings change rather than a deployment.
 */
export function pickRail(preferred: PayoutRailName | null | undefined, settings: RailSettings): PayoutRail {
  const order: PayoutRailName[] = [];
  if (preferred) order.push(preferred);
  order.push(settings.primaryRail, ...settings.railFallbackOrder, 'MANUAL_NEFT');
  for (const name of order) {
    // Manual is chosen the moment it is reached: a preference or a primary
    // rail set to manual means "by hand", not "try the vendors first".
    if (name === 'MANUAL_NEFT') return manualNeftRail;
    const rail = byName(name);
    if (rail?.isConfigured()) return rail;
  }
  return manualNeftRail;
}

/** `pickRail` against the live platform settings. */
export async function railFor(preferred?: PayoutRailName | null): Promise<PayoutRail> {
  const { finance } = await getPlatformSettings();
  return pickRail(preferred, finance);
}

export const availableRails = () =>
  RAILS.map((rail) => ({
    name: rail.name,
    configured: rail.isConfigured(),
    pennyDrop: rail.supportsPennyDrop(),
  }));
