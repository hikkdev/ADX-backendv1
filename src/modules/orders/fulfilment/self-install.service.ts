import { haversineMeters } from '../../../shared/geo';
import { logger } from '../../../shared/logging';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyAdmins, shortId } from '../orders.notify';
import { printJobPort } from '../print-job.port';

/**
 * The publisher-installs-it-themselves path, taken when the publisher answers
 * P2 with `installBy: 'PUBLISHER'` and ADX then marks the prints ready
 * (`markPrintReady` forks on that answer). It used to fork on the listing's
 * `agentCanInstall`, a boolean nothing ever wrote, so this lane was
 * unreachable — the docblock outlived the route it described.
 *
 * Every step requires status SELF_INSTALL and the caller to be the listing's
 * publisher.
 *
 * Unlike the agent path there is no OTP: the final step goes straight to
 * PENDING_APPROVAL for an admin to review.
 *
 * Evidence is filed exactly as the agent lane files it — OrderPhoto rows, plus
 * the scalar columns the admin console reads. Writing only the columns is what
 * this lane used to do, and `fulfilmentEvidence` groups the rows: a publisher
 * who photographed every step opened Proof of Work and was told nothing had
 * been filed against the booking.
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
  await repository.addPhotos(
    orderId,
    'PICKUP',
    [{ url: photoUrl, label: 'Material collected' }],
    publisherUserId,
  );
  const updated = await repository.update(orderId, { selfInstallCollectPhotoUrl: photoUrl });
  // Lot B (B4b): the publisher collecting from the print shop is a collection
  // too; the job records it, and a job that cannot be marked never fails the step.
  await printJobPort()
    .markCollected(orderId, new Date())
    .catch((err) => logger.warn('Could not mark the print job collected', { orderId, err }));
  return updated;
}

export async function selfInstallCaptureCondition(
  orderId: string,
  publisherUserId: string,
  photoUrls: string[],
) {
  await requireSelfInstallOrder(orderId, publisherUserId);
  // Unnamed, like the agent lane's extra shots: this screen asks for
  // photographs of the spot without naming each one, and inventing a caption
  // would say more than the publisher did.
  await repository.addPhotos(
    orderId,
    'CONDITION',
    photoUrls.map((url) => ({ url, label: null })),
    publisherUserId,
  );
  return repository.update(orderId, { selfInstallConditionPhotoUrls: photoUrls });
}

/**
 * The publisher says they are at the spot.
 *
 * Everything in the body is optional and nothing here is a gate. The publisher
 * owns the spot, so their presence is not in doubt the way an agent's is; what
 * this records is when the work was done and, when the device offered a fix,
 * how far from the spot's own coordinates it was filed. Distance is recorded
 * rather than enforced, exactly as on the agent lane.
 *
 * A token that matches the listing's own is a real scan and is recorded as
 * one — that is the flag `fulfilmentEvidence` reads. A token that does not
 * match is not an error: refusing the check-in over a peeled sticker would
 * strand a publisher mid-install, and the check-in stamp below carries the
 * CHECK_IN requirement on its own.
 */
export async function selfInstallCheckIn(
  orderId: string,
  publisherUserId: string,
  at: { latitude?: number; longitude?: number; qrToken?: string } = {},
) {
  const order = await requireSelfInstallOrder(orderId, publisherUserId);

  if (typeof at.latitude === 'number' && typeof at.longitude === 'number') {
    const distanceM = haversineMeters(
      at.latitude,
      at.longitude,
      order.listing.latitude ?? at.latitude,
      order.listing.longitude ?? at.longitude,
    );
    await repository.upsertCheckIn(orderId, {
      latitude: at.latitude,
      longitude: at.longitude,
      distanceM,
    });
  }

  if (at.qrToken && order.listing.qrToken && at.qrToken === order.listing.qrToken) {
    await repository.upsertVerification(orderId, { qrScanned: true });
  }

  return repository.update(orderId, { selfInstallCheckedInAt: new Date() });
}

export async function selfInstallCaptureInstallation(
  orderId: string,
  publisherUserId: string,
  photoUrl: string,
) {
  await requireSelfInstallOrder(orderId, publisherUserId);

  await repository.addPhotos(
    orderId,
    'INSTALLATION',
    [{ url: photoUrl, label: 'Advertisement in place' }],
    publisherUserId,
  );

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
