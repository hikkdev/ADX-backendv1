import type { GatewayAdapter, GatewayName } from './gateway';
import { createRazorpayAdapter } from './razorpay';
import { createCashfreeAdapter } from './cashfree';
import { createCcavenueAdapter } from './ccavenue';

/**
 * The three adapters, built once over their live config loaders. Tests swap
 * an adapter in with `setAdapter` and put the real one back afterwards.
 */
const adapters: Record<GatewayName, GatewayAdapter> = {
  RAZORPAY: createRazorpayAdapter(),
  CASHFREE: createCashfreeAdapter(),
  CCAVENUE: createCcavenueAdapter(),
};

export const GATEWAY_NAMES: readonly GatewayName[] = ['RAZORPAY', 'CASHFREE', 'CCAVENUE'];

export function adapterFor(gateway: GatewayName): GatewayAdapter {
  return adapters[gateway];
}

/** Only for tests. */
export function setAdapter(gateway: GatewayName, adapter: GatewayAdapter | null): void {
  adapters[gateway] =
    adapter ??
    (gateway === 'RAZORPAY' ? createRazorpayAdapter() : gateway === 'CASHFREE' ? createCashfreeAdapter() : createCcavenueAdapter());
}
