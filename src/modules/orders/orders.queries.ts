import { prismaOrdersRepository as repository } from './prisma-orders.repository';
import type { OrderListFilters } from './orders.repository';

export async function getOrderById(orderId: string) {
  return repository.findDetail(orderId);
}

export async function getOrdersForAdvertiser(advertiserId: string) {
  return repository.findForAdvertiser(advertiserId);
}

export async function getOrdersForPublisher(publisherUserId: string) {
  return repository.findForPublisherUser(publisherUserId);
}

export async function getOrdersForAgent(agentProfileId: string) {
  return repository.findForAgent(agentProfileId);
}

export async function getAllOrders(filters: OrderListFilters) {
  return repository.findAll(filters);
}

/**
 * Orders whose 30-minute publisher-response window lapsed inside the given
 * slice. Used by jobs/publisher-timer, which alerts admins once per order.
 */
export async function findPublisherTimerExpired(windowStart: Date, now: Date) {
  return repository.findPublisherTimerExpired(windowStart, now);
}
