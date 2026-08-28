import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyAdmins, shortId } from '../orders.notify';

/**
 * The publisher-installs-it-themselves path, taken when a listing has
 * `agentCanInstall: false`. Every step requires status SELF_INSTALL and the
 * caller to be the listing's publisher.
 *
 * Unlike the agent path there is no OTP: the final step goes straight to
 * PENDING_APPROVAL for an admin to review.
 */
async function requireSelfInstallOrder(orderId: string, publisherUserId: string) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SELF_INSTALL') throw new Error('WRONG_STATUS');
  return order;
}

export async function selfInstallCollectPrints(
  orderId: string,
  publisherUserId: string,
  photoUrl: string,
) {
  await requireSelfInstallOrder(orderId, publisherUserId);
  return repository.update(orderId, { selfInstallCollectPhotoUrl: photoUrl });
}

export async function selfInstallCaptureCondition(
  orderId: string,
  publisherUserId: string,
  photoUrls: string[],
) {
  await requireSelfInstallOrder(orderId, publisherUserId);
  return repository.update(orderId, { selfInstallConditionPhotoUrls: photoUrls });
}

export async function selfInstallCheckIn(orderId: string, publisherUserId: string) {
  await requireSelfInstallOrder(orderId, publisherUserId);
  return repository.update(orderId, { selfInstallCheckedInAt: new Date() });
}

export async function selfInstallCaptureInstallation(
  orderId: string,
  publisherUserId: string,
  photoUrl: string,
) {
  await requireSelfInstallOrder(orderId, publisherUserId);

  const updated = await repository.update(orderId, {
    status: 'PENDING_APPROVAL',
    selfInstallInstallPhotoUrl: photoUrl,
  });

  notifyAdmins(
    'Self-install complete — review needed',
    `Order ${shortId(orderId)} was self-installed by publisher. Please review and approve.`,
    orderId,
  ).catch(() => {});

  return updated;
}
