import { registerPrintJobPort } from '../orders';
import { markCollected, pickupsForOrders, printJobFor } from './print-jobs.service';

/**
 * Wires this module into the port `orders` declares — see
 * `orders/print-job.port.ts` for why the dependency runs that way round.
 */
export function registerPrintPartnersModule(): void {
  registerPrintJobPort({
    printJobFor: (orderId) => printJobFor(orderId),
    pickupsFor: (orderIds) => pickupsForOrders(orderIds),
    markCollected: (orderId, at) => markCollected(orderId, at),
  });
}
