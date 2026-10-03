import type { GatewayAdapter, GatewayName } from './gateway';
import { createRazorpayAdapter } from './razorpay';
import { createCashfreeAdapter } from './cashfree';
import { createCcavenueAdapter } from './ccavenue';

/**
 * The three adapters, built once over their live config loaders. Tests swap
 * an adapter in with `setAdapter` and put the real one back afterwards.
 */
/** BT-1: a bank transfer has no adapter — no order to open, no signature, no webhook. Ops confirm it by hand. */
export type AdapterGatewayName = Exclude<GatewayName, 'BANK_TRANSFER'>;

const adapters: Record<AdapterGatewayName, GatewayAdapter> = {
  RAZORPAY: createRazorpayAdapter(),
  CASHFREE: createCashfreeAdapter(),
  CCAVENUE: createCcavenueAdapter(),
};

export const GATEWAY_NAMES: readonly AdapterGatewayName[] = ['RAZORPAY', 'CASHFREE', 'CCAVENUE'];

export function adapterFor(gateway: GatewayName): GatewayAdapter {
  if (gateway === 'BANK_TRANSFER') throw new Error('BANK_TRANSFER has no gateway adapter; it is confirmed by ops (payments.service#confirmBankTransfer)');
  return adapters[gateway];
}

/** Only for tests. */
export function setAdapter(gateway: AdapterGatewayName, adapter: GatewayAdapter | null): void {
  adapters[gateway] =
    adapter ??
    (gateway === 'RAZORPAY' ? createRazorpayAdapter() : gateway === 'CASHFREE' ? createCashfreeAdapter() : createCcavenueAdapter());
}
