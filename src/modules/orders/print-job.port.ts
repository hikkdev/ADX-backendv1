/**
 * Lot B (B4b): how an order reaches its print job without importing the
 * module that owns it.
 *
 * `print-partners` reads orders — a job is opened against an order that has
 * reached PENDING_PRINT, and it asks `orders.getOrderSummary` for that — so
 * `orders` importing `print-partners` back would close a cycle. The two
 * things an order needs from the job are declared here as a port and
 * bootstrap fills it: where the agent collects the prints (the partner's
 * address, stamped into the PICKUP code and printed on the order read), and
 * the collect-prints step marking the job COLLECTED.
 *
 * Unregistered, the port answers "no job" and records nothing, so an order
 * with no print partner behind it — every order before this lot — reads and
 * moves exactly as it did.
 */

export type PickupPoint = {
  printPartnerId: string;
  name: string;
  contactName: string | null;
  mobile: string;
  address: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type OrderPrintJob = {
  id: string;
  status: string;
  quotedCost: string | null;
  actualCost: string | null;
  requestedAt: Date;
  readyAt: Date | null;
  collectedAt: Date | null;
  pickup: PickupPoint;
};

export type PrintJobPort = {
  /** The order's job and the pickup point, or null when no partner is printing it. */
  printJobFor(orderId: string): Promise<OrderPrintJob | null>;
  /**
   * E9: the pickup points of a page of orders in one read, keyed by order id;
   * an order no partner is printing is simply absent. `GET /orders/my` reads
   * its rows through this rather than one `printJobFor` per row.
   */
  pickupsFor(orderIds: readonly string[]): Promise<ReadonlyMap<string, PickupPoint>>;
  /** The agent has the material: the job goes COLLECTED. A no-op without a job. */
  markCollected(orderId: string, at: Date): Promise<void>;
};

const NONE: PrintJobPort = {
  printJobFor: async () => null,
  pickupsFor: async () => new Map(),
  markCollected: async () => undefined,
};

let registered: PrintJobPort = NONE;

export function registerPrintJobPort(port: PrintJobPort): void {
  registered = port;
}

/** Only for tests, which wire and unwire the port between cases. */
export function resetPrintJobPort(): void {
  registered = NONE;
}

export function printJobPort(): PrintJobPort {
  return registered;
}
