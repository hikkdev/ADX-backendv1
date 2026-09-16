import { money, type Money } from '../../shared/money';
import { toListPage, type ListPage } from '../../shared/pagination';
import { prismaOrdersRepository as repository } from './prisma-orders.repository';
import { printJobPort, type OrderPrintJob, type PickupPoint } from './print-job.port';
import type { MyOrderRow, OpenOrderScope } from './orders.repository';
import type { AdminOrdersQuery, CalendarQuery, MyOrdersQuery } from './orders.schema';

/**
 * Lot B (Q102): the installation figure the agent accepted the job at, as a
 * decimal string — the accepted assignment's `quotedFee`, null until there is
 * one. The detail aggregate carries every assignment; this reads the one that
 * matters off it so the app never has to.
 */
function acceptedQuote(order: { agentAssignments?: { status: string; quotedFee: unknown }[] } | null): string | null {
  const accepted = order?.agentAssignments?.find((assignment) => assignment.status === 'ACCEPTED');
  return accepted?.quotedFee === null || accepted?.quotedFee === undefined ? null : money(accepted.quotedFee as never);
}

/** E7-2: what the agent's offer sheet draws for the collect-prints row. */
export type MyOrderPrintJob = { pickup: { name: string; address: string | null } };

/**
 * The persona lists' rows, with the quote printed as money and (E7-2) the
 * print job's pickup point through the port `GET /orders/:id` already uses —
 * null when no partner is printing, and null rather than a failed page when
 * the port cannot answer. E9: the whole page's pickups come from one
 * `pickupsFor(orderIds)` call, not one `printJobFor` per row.
 */
async function withQuote(items: MyOrderRow[]) {
  const ids = items.map((row) => row.id);
  const pickups: ReadonlyMap<string, PickupPoint> = ids.length
    ? await printJobPort()
        .pickupsFor(ids)
        .catch(() => new Map<string, PickupPoint>())
    : new Map<string, PickupPoint>();
  return items.map((row) => {
    const pickup = pickups.get(row.id);
    const printJob: MyOrderPrintJob | null = pickup ? { pickup: { name: pickup.name, address: pickup.address } } : null;
    return { ...row, quotedFee: row.quotedFee === null ? null : money(row.quotedFee), printJob };
  });
}

export async function getOrderById(
  orderId: string,
): Promise<(Record<string, unknown> & { quotedFee: string | null; printJob: OrderPrintJob | null }) | null> {
  const order = await repository.findDetail(orderId);
  if (!order) return null;
  // Lot B (B4b): the print job and its pickup point, when a partner is
  // printing this order — the agent's collect-prints step reads the address
  // off this. Through the port, and null rather than a failed read.
  const printJob = await printJobPort()
    .printJobFor(orderId)
    .catch(() => null);
  return { ...(order as Record<string, unknown>), quotedFee: acceptedQuote(order as never), printJob };
}

/**
 * The slice of an order other modules reason about — its status (for
 * finalised-order guards), its agent and its listing. Used by
 * `order-milestones`.
 */
export async function getOrderSummary(orderId: string) {
  return repository.findSummary(orderId);
}

/** K-B1: `{ id, label, displayId }` per order id, one query — the QR desk names an ORDER code's order with it. */
export const findOrderLabels = (ids: readonly string[]) => repository.findLabelsByIds([...new Set(ids)]);

/**
 * The caller's own orders, one page at a time, with a count per status chip.
 *
 * Three queries rather than one because the three personas reach an order by
 * three different joins — the advertiser owns it, the publisher owns the spot
 * it runs on, the agent is assigned to it — and only the shape they answer in
 * is shared.
 */
export async function getOrdersForAdvertiser(advertiserId: string, query: MyOrdersQuery) {
  const { items, total, counts } = await repository.findForAdvertiser(advertiserId, query);
  return toListPage(await withQuote(items), total, counts, query);
}

export async function getOrdersForPublisher(publisherUserId: string, query: MyOrdersQuery) {
  const { items, total, counts } = await repository.findForPublisherUser(publisherUserId, query);
  return toListPage(await withQuote(items), total, counts, query);
}

export async function getOrdersForAgent(agentProfileId: string, query: MyOrdersQuery) {
  const { items, total, counts } = await repository.findForAgent(agentProfileId, query);
  return toListPage(await withQuote(items), total, counts, query);
}

/**
 * The statuses in which an agent is holding a job and the on-site work is
 * still ahead of them — the window in which a milestone plan is worth issuing.
 *
 * Not PENDING_AGENT: nobody holds it yet, and a plan materialised then would be
 * dispatched to no one and block a later, correct issue. Not PENDING_OTP or
 * anything past it: the work is done.
 */
const MILESTONE_ISSUING_STATUSES = ['SLOT_PROPOSED', 'SLOT_CONFIRMED', 'IN_PROGRESS'];

/**
 * The ids of the jobs an agent is holding that are still to be worked.
 *
 * Used by `order-milestones` to issue the plans those jobs are owed. Ids only —
 * that module reads the order through `getOrderSummary` if it needs more.
 */
export async function getAgentOrderIdsAwaitingWork(agentProfileId: string) {
  return repository.findAgentOrderIdsInStatuses(agentProfileId, MILESTONE_ISSUING_STATUSES);
}

/**
 * The DR 10 order board, one page at a time, with the chip counts beside it.
 *
 * The counts are computed without the caller's own status facet, so selecting
 * "In progress" still says how many are awaiting a publisher.
 */
export async function getAllOrders(query: AdminOrdersQuery) {
  const { items, total, counts } = await repository.findAll(query);
  return toListPage(items, total, counts, query);
}

/** Lot G (Q114): one row of the booking calendar. */
export type CalendarRow = {
  listing: { id: string; displayId: string | null; title: string; city: string | null; category: string; slotsTotal: number };
  orders: {
    id: string;
    /** The campaign the order was raised from; a direct booking has only the name typed on the order. */
    campaign: { id: string | null; reference: string | null; name: string | null };
    status: string;
    from: string | null;
    to: string | null;
    /** The confirmed installation appointment, when there is one. */
    slot: string | null;
  }[];
};

/**
 * Lot G (Q114): the booking calendar, listings first.
 *
 * `GET /orders` is an order list, so a spot with nothing booked is invisible
 * on it — and a calendar is exactly the screen that needs to show the empty
 * week. This pages ACTIVE listings in the filter and hangs the window's
 * slot-holding orders on each; the chips are by listing category, counted
 * with the category facet removed so they stay a way back out.
 */
export async function getBookingCalendar(query: CalendarQuery): Promise<ListPage<CalendarRow>> {
  const [{ items, total }, counts] = await Promise.all([
    repository.findCalendar(query),
    repository.countCalendarByCategory({ ...query, category: undefined }),
  ]);
  const rows = items.map((listing) => ({
    listing: {
      id: listing.id,
      displayId: listing.displayId,
      title: listing.title,
      city: listing.city,
      category: listing.category,
      slotsTotal: listing.slotsTotal,
    },
    orders: listing.orders.map((order) => ({
      id: order.id,
      campaign: {
        id: order.campaignSpot?.campaign.id ?? null,
        reference: order.campaignSpot?.campaign.reference ?? null,
        name: order.campaignSpot?.campaign.name ?? order.campaignName,
      },
      status: order.status,
      from: order.startDate ? order.startDate.toISOString() : null,
      to: order.endDate ? order.endDate.toISOString() : null,
      slot: order.slotTime ? order.slotTime.toISOString() : null,
    })),
  }));
  return toListPage(rows, total, counts, query);
}

/**
 * Orders whose 30-minute publisher-response window lapsed inside the given
 * slice. Used by jobs/publisher-timer, which alerts admins once per order.
 */
export async function findPublisherTimerExpired(windowStart: Date, now: Date) {
  return repository.findPublisherTimerExpired(windowStart, now);
}

/**
 * Every order still running on these spots — what Lot A's STOP_OPEN_WORK
 * cancels when a listing or a whole publisher is suspended.
 *
 * Non-terminal means anything but COMPLETED and CANCELLED: an order awaiting a
 * publisher, awaiting print or half-installed is exactly the work that has to
 * stop, and a completed one is history that must not be touched.
 */
export async function findOpenOrdersForListings(listingIds: string[]) {
  return repository.findOpenForListings(listingIds);
}

/**
 * The same question from the demand side, for Lot A's closure review: the
 * non-terminal orders this person placed. `Order.advertiserId` is a User id.
 */
export async function findOpenOrdersForAdvertiserUser(userId: string) {
  return repository.findOpenForAdvertiserUser(userId);
}

/**
 * G11-1: the non-terminal orders on a party and what they are worth, as
 * `fraud`'s linked-accounts rail reads them — one aggregate per party, the
 * value as money ("0.00" with nothing open, or open orders carrying no budget).
 */
export async function openOrderExposureFor(scope: OpenOrderScope): Promise<{ count: number; value: Money }> {
  const { count, value } = await repository.countOpenExposure(scope);
  return { count, value: money(value ?? 0) };
}

/**
 * How many offers this agent has not answered — the "open agent work" line on
 * the closure review. STOP_OPEN_WORK hands them back, so it is reported and
 * never a blocker.
 */
export async function countPendingAgentOffers(agentProfileId: string): Promise<number> {
  return (await repository.findPendingAssignmentsForAgent(agentProfileId)).length;
}

/**
 * The jobs an agent holds whose slot falls inside a window — the day view.
 *
 * Reads through the paged repository with a large page rather than a bare
 * findMany: an agent with more than a hundred slots on one day has a different
 * problem than this endpoint can solve.
 */
export async function getAgentOrdersInWindow(agentProfileId: string, window: { start: Date; end: Date }) {
  const { items } = await repository.findForAgent(agentProfileId, {
    page: 1,
    pageSize: 100,
    sort: 'DUE',
  });
  return items.filter(
    (order) => order.slotTime !== null && order.slotTime >= window.start && order.slotTime < window.end,
  );
}
