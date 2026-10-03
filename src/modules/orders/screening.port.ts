import { logger } from '../../shared/logging';

/**
 * Order fraud screening (the owner, 2 Oct 2026): "every order is scored
 * automatically" — the moment an order is placed, and again when the money
 * behind it is taken, without this module knowing who scores it.
 *
 * `fraud` scores orders and reads them through this module's index, so an
 * import the other way would close a ring. Placement tells the port; bootstrap
 * fills it with `fraud.screenOrderInBackground`. Unregistered, nothing is
 * scored at placement — the nightly re-screen still reaches every open order.
 *
 * The port never throws into the order flow: the call is not awaited by
 * placement, and a failure is logged and swallowed here — the order stands.
 */

export type OrderScreeningPort = {
  /** An order was just placed. */
  orderPlaced(orderId: string): Promise<void>;
  /**
   * The money behind these orders was taken: the campaign was paid (a
   * gateway capture, or the wallet hold placed at authorisation) or its
   * hold was captured at launch. Re-scored then, with the campaign linked.
   */
  ordersPaid(orderIds: string[]): Promise<void>;
};

const NONE: OrderScreeningPort = { orderPlaced: async () => undefined, ordersPaid: async () => undefined };

let registered: OrderScreeningPort = NONE;

export function registerOrderScreeningPort(port: OrderScreeningPort): void {
  registered = port;
}

/** Only for tests, which wire and unwire the port between cases. */
export function resetOrderScreeningPort(): void {
  registered = NONE;
}

/** Fire-and-forget: tells the screening an order was placed; never rejects. */
export function announceOrderPlaced(orderId: string): void {
  void Promise.resolve()
    .then(() => registered.orderPlaced(orderId))
    .catch((err: unknown) => logger.warn('Order screening at placement failed; the order stands', { orderId, err: err instanceof Error ? err.message : String(err) }));
}

/** Fire-and-forget: tells the screening the money behind these orders was taken; never rejects. */
export function announceOrdersPaid(orderIds: readonly (string | null | undefined)[]): void {
  const ids = [...new Set(orderIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  void Promise.resolve()
    .then(() => registered.ordersPaid(ids))
    .catch((err: unknown) => logger.warn('Order screening on payment failed; the orders stand', { orderIds: ids, err: err instanceof Error ? err.message : String(err) }));
}
