import { prisma } from '../shared/database';
import bcrypt from 'bcryptjs';
import { createNotification } from './notification.service';
import { autoAssignAgent } from './orderAssignment.service';
import { logger } from '../shared/logging';

export async function placeOrder(data: {
  advertiserId: string;
  listingId: string;
  campaignName?: string;
  designUrl?: string;
  budget?: number;
  startDate?: Date;
  endDate?: Date;
  notes?: string;
}) {
  const listing = await prisma.listing.findUnique({
    where: { id: data.listingId },
    include: { publisher: { include: { user: true } } },
  });
  if (!listing) throw new Error('LISTING_NOT_FOUND');
  if (listing.status !== 'ACTIVE') throw new Error('LISTING_NOT_ACTIVE');

  // Auto-free listing if existing completed campaign's endDate has passed
  if (!listing.availableNow) {
    const completedOrder = await prisma.order.findFirst({
      where: { listingId: data.listingId, status: 'COMPLETED', endDate: { lt: new Date() } },
    });
    if (completedOrder) {
      await prisma.listing.update({ where: { id: data.listingId }, data: { availableNow: true } });
    } else {
      throw new Error('LISTING_NOT_AVAILABLE');
    }
  }

  const order = await prisma.order.create({
    data: { ...data, status: 'PENDING_PUBLISHER', publisherTimerExpiry: new Date(Date.now() + 30 * 60 * 1000) },
    include: { listing: { include: { publisher: { include: { user: true } } } } },
  });

  if (listing.publisher?.userId) {
    createNotification({
      userId: listing.publisher.userId, type: 'ORDER',
      title: 'New order request',
      message: `A new order has been placed for your listing "${listing.title}".`,
      relatedId: order.id,
    }).catch(() => {});
  }

  return order;
}

export async function publisherAcceptOrder(orderId: string, publisherUserId: string, meetingPlace: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'PENDING_PUBLISHER') throw new Error('WRONG_STATUS');

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: 'PENDING_PRINT', publisherAcceptedAt: new Date(), meetingPlace },
  });

  Promise.all([
    createNotification({ userId: order.advertiserId, type: 'ORDER', title: 'Order accepted', message: 'The publisher accepted your order.', relatedId: orderId }),
    notifyAdmins('Order ready for print', `Order ${orderId.slice(-6).toUpperCase()} accepted by publisher.`, orderId),
  ]).catch(() => {});

  return updated;
}

export async function publisherRejectOrder(orderId: string, publisherUserId: string, reason?: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'PENDING_PUBLISHER') throw new Error('WRONG_STATUS');

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: 'PUBLISHER_REJECTED', publisherRejectedAt: new Date(), publisherRejectionReason: reason },
  });

  Promise.all([
    createNotification({ userId: order.advertiserId, type: 'ORDER', title: 'Order rejected', message: 'The publisher rejected your order. Check similar listings.', relatedId: orderId }),
    notifyAdmins('Publisher rejected order', `Order ${orderId.slice(-6).toUpperCase()} was rejected.`, orderId),
  ]).catch(() => {});

  return updated;
}

export async function markPrintReady(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: { include: { user: true } } } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_PRINT') throw new Error('WRONG_STATUS');

  if (!order.listing.agentCanInstall) {
    // Self-install path: notify publisher to install themselves
    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { status: 'SELF_INSTALL', printReadyAt: new Date() },
    });
    if (order.listing.publisher?.userId) {
      createNotification({
        userId: order.listing.publisher.userId,
        type: 'ORDER',
        title: 'Prints ready — please install',
        message: `Prints for order ${orderId.slice(-6).toUpperCase()} are ready. Please collect and install them yourself.`,
        relatedId: orderId,
      }).catch(() => {});
    }
    return updated;
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: 'PENDING_AGENT', printReadyAt: new Date() },
  });
  autoAssignAgent(orderId).catch((err) => logger.error('autoAssignAgent failed', { orderId, err }));
  return updated;
}

export async function agentAcceptOrder(orderId: string, agentProfileId: string) {
  const assignment = await prisma.orderAgentAssignment.findFirst({
    where: { orderId, agentId: agentProfileId, status: 'PENDING' },
  });
  if (!assignment) throw new Error('ASSIGNMENT_NOT_FOUND');
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_AGENT') throw new Error('WRONG_STATUS');

  await prisma.$transaction([
    prisma.orderAgentAssignment.update({ where: { id: assignment.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } }),
    prisma.order.update({ where: { id: orderId }, data: { status: 'SLOT_PROPOSED', agentId: agentProfileId } }),
  ]);

  return prisma.order.findUnique({ where: { id: orderId } });
}

export async function agentRejectOrder(orderId: string, agentProfileId: string, reason?: string) {
  const assignment = await prisma.orderAgentAssignment.findFirst({
    where: { orderId, agentId: agentProfileId, status: 'PENDING' },
  });
  if (!assignment) throw new Error('ASSIGNMENT_NOT_FOUND');
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_AGENT') throw new Error('WRONG_STATUS');

  await prisma.$transaction([
    prisma.orderAgentAssignment.update({ where: { id: assignment.id }, data: { status: 'REJECTED', rejectionReason: reason, respondedAt: new Date() } }),
    prisma.order.update({ where: { id: orderId }, data: { agentRejectionCount: { increment: 1 } } }),
  ]);

  autoAssignAgent(orderId).catch((err) => logger.error('autoAssignAgent re-assign failed', { orderId, err }));

  return prisma.order.findUnique({ where: { id: orderId } });
}

export async function agentProposeSlot(orderId: string, agentProfileId: string, slotTime: Date) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SLOT_PROPOSED') throw new Error('WRONG_STATUS');

  const updated = await prisma.order.update({ where: { id: orderId }, data: { slotTime, slotProposedAt: new Date() } });

  const listing = await prisma.listing.findUnique({ where: { id: order.listingId }, include: { publisher: true } });
  if (listing?.publisher?.userId) {
    createNotification({
      userId: listing.publisher.userId, type: 'ORDER',
      title: 'Agent proposed a meeting time',
      message: `The agent proposed a time slot for order ${orderId.slice(-6).toUpperCase()}.`,
      relatedId: orderId,
    }).catch(() => {});
  }

  return updated;
}

export async function publisherConfirmSlot(orderId: string, publisherUserId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SLOT_PROPOSED') throw new Error('WRONG_STATUS');

  const updated = await prisma.order.update({ where: { id: orderId }, data: { status: 'SLOT_CONFIRMED', slotConfirmedAt: new Date() } });

  // Mark listing occupied as soon as slot is locked in
  await prisma.listing.update({ where: { id: order.listingId }, data: { availableNow: false } });

  if (order.agentId) {
    const agent = await prisma.agentProfile.findUnique({ where: { id: order.agentId }, include: { user: true } });
    if (agent?.user) {
      createNotification({ userId: agent.user.id, type: 'ORDER', title: 'Slot confirmed — installation unlocked', message: 'Publisher confirmed your slot. Collect prints to begin.', relatedId: orderId }).catch(() => {});
    }
  }

  return updated;
}

export async function publisherCounterSlot(orderId: string, publisherUserId: string, counterNote?: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SLOT_PROPOSED') throw new Error('WRONG_STATUS');
  if (order.slotCounterCount >= 3) throw new Error('COUNTER_LIMIT_REACHED');

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { slotCounterCount: { increment: 1 }, notes: counterNote, slotTime: null, slotProposedAt: null },
  });

  if (order.agentId) {
    const agent = await prisma.agentProfile.findUnique({ where: { id: order.agentId }, include: { user: true } });
    if (agent?.user) {
      createNotification({ userId: agent.user.id, type: 'ORDER', title: 'Publisher rejected your slot', message: counterNote ?? 'Propose a new time.', relatedId: orderId }).catch(() => {});
    }
  }

  return updated;
}

export async function agentCollectPrints(orderId: string, agentProfileId: string, photoUrl: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status === 'IN_PROGRESS') return order; // already past this step, no-op
  if (order.status !== 'SLOT_CONFIRMED') throw new Error('WRONG_STATUS');
  return prisma.order.update({ where: { id: orderId }, data: { status: 'IN_PROGRESS' } });
}

export async function agentCaptureCondition(orderId: string, agentProfileId: string, photoUrls: string[]) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  const pastStatuses = ['PENDING_OTP', 'PENDING_APPROVAL', 'COMPLETED'];
  if (pastStatuses.includes(order.status)) {
    await prisma.siteVerification.upsert({ where: { orderId }, update: { wideAngleUrl: photoUrls[0], closeUpUrl: photoUrls[1] }, create: { orderId, wideAngleUrl: photoUrls[0], closeUpUrl: photoUrls[1] } });
    return order;
  }
  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');
  await prisma.siteVerification.upsert({
    where: { orderId },
    update: { wideAngleUrl: photoUrls[0], closeUpUrl: photoUrls[1] },
    create: { orderId, wideAngleUrl: photoUrls[0], closeUpUrl: photoUrls[1] },
  });
  return order;
}

export async function agentRejectCondition(orderId: string, agentProfileId: string, reason: string, photoUrls: string[]) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');

  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'PENDING_AGENT', agentId: null, agentRejectionCount: { increment: 1 } },
  });

  autoAssignAgent(orderId).catch((err) => logger.error('autoAssignAgent R3 re-assign failed', { orderId, err }));

  return prisma.order.findUnique({ where: { id: orderId } });
}

export async function agentCaptureInstallation(orderId: string, agentProfileId: string, photoUrl: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status === 'PENDING_OTP' || order.status === 'PENDING_APPROVAL') {
    // Already past this step — just update the photo and return
    await prisma.siteVerification.upsert({ where: { orderId }, update: { landmarkUrl: photoUrl }, create: { orderId, landmarkUrl: photoUrl } });
    return order;
  }
  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');
  await prisma.siteVerification.upsert({
    where: { orderId },
    update: { landmarkUrl: photoUrl },
    create: { orderId, landmarkUrl: photoUrl },
  });
  return order;
}

export async function requestCompletionOtp(orderId: string, agentProfileId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'IN_PROGRESS' && order.status !== 'PENDING_OTP') throw new Error('WRONG_STATUS');

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const hash = await bcrypt.hash(otp, 10);
  const expiry = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.order.update({ where: { id: orderId }, data: { status: 'PENDING_OTP', completionOtp: hash, completionOtpPlain: otp, completionOtpExpiry: expiry } });

  if (order.listing.publisher?.userId) {
    createNotification({
      userId: order.listing.publisher.userId, type: 'ORDER',
      title: `Completion code: ${otp}`,
      message: 'Share this code with the agent. Valid for 10 minutes.',
      relatedId: orderId,
    }).catch(() => {});
  }

  return { success: true };
}

export async function verifyCompletionOtp(orderId: string, agentProfileId: string, otp: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'PENDING_OTP') throw new Error('WRONG_STATUS');
  if (!order.completionOtp || !order.completionOtpExpiry) throw new Error('OTP_NOT_REQUESTED');
  if (new Date() > order.completionOtpExpiry) throw new Error('OTP_EXPIRED');

  const valid = await bcrypt.compare(otp, order.completionOtp);
  if (!valid) throw new Error('OTP_INVALID');

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: 'PENDING_APPROVAL', completionOtp: null, completionOtpPlain: null },
  });

  notifyAdmins('Order ready for approval', `Order ${orderId.slice(-6).toUpperCase()} OTP verified.`, orderId).catch(() => {});

  return updated;
}

export async function approveOrder(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_APPROVAL') throw new Error('WRONG_STATUS');

  const updated = await prisma.order.update({ where: { id: orderId }, data: { status: 'COMPLETED', adminApprovedAt: new Date() } });

  // Listing is now occupied — keep availableNow = false (already set at SLOT_CONFIRMED)
  await prisma.listing.update({ where: { id: order.listingId }, data: { availableNow: false } });

  const full = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } }, agent: { include: { user: true } } },
  });
  const notifs = [
    createNotification({ userId: order.advertiserId, type: 'ORDER', title: 'Order completed', message: 'Your order has been approved.', relatedId: orderId }),
  ];
  if (full?.listing.publisher?.userId) notifs.push(createNotification({ userId: full.listing.publisher.userId, type: 'ORDER', title: 'Order completed', message: 'Installation approved.', relatedId: orderId }));
  if (full?.agent?.user) notifs.push(createNotification({ userId: full.agent.user.id, type: 'ORDER', title: 'Order approved', message: 'Well done! Order has been approved.', relatedId: orderId }));
  Promise.all(notifs).catch(() => {});

  return updated;
}

export async function cancelOrder(orderId: string, reason?: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status === 'COMPLETED') throw new Error('ALREADY_COMPLETED');
  const updated = await prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED', notes: reason } });
  // Free the listing if it was occupied by this order
  await prisma.listing.update({ where: { id: order.listingId }, data: { availableNow: true } });
  return updated;
}

export async function endCampaign(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'COMPLETED') throw new Error('WRONG_STATUS');
  await prisma.listing.update({ where: { id: order.listingId }, data: { availableNow: true } });
  return prisma.order.update({ where: { id: orderId }, data: { endDate: new Date() } });
}

export async function adminAssignAgent(orderId: string, agentProfileId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_AGENT') throw new Error('WRONG_STATUS');

  await prisma.orderAgentAssignment.create({ data: { orderId, agentId: agentProfileId, status: 'PENDING' } });
  await prisma.order.update({ where: { id: orderId }, data: { agentId: agentProfileId, agentEscalated: false } });

  const agent = await prisma.agentProfile.findUnique({ where: { id: agentProfileId }, include: { user: true } });
  if (agent?.user) {
    createNotification({ userId: agent.user.id, type: 'ORDER', title: 'New order assigned', message: `Order ${orderId.slice(-6).toUpperCase()} has been assigned to you.`, relatedId: orderId }).catch(() => {});
  }

  return prisma.order.findUnique({ where: { id: orderId } });
}

export async function getOrderById(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: {
      listing: { include: { publisher: { include: { user: true } }, agent: { include: { user: true } } } },
      advertiser: true,
      agent: { include: { user: true } },
      agentAssignments: { include: { agent: { include: { user: true } } }, orderBy: { assignedAt: 'desc' } },
      checkIn: true,
      verification: true,
      milestones: { include: { template: true }, orderBy: { order: 'asc' } },
    },
  });
}

export async function getOrdersForAdvertiser(advertiserId: string) {
  return prisma.order.findMany({ where: { advertiserId }, include: { listing: true }, orderBy: { createdAt: 'desc' } });
}

export async function getOrdersForPublisher(publisherUserId: string) {
  return prisma.order.findMany({
    where: { listing: { publisher: { userId: publisherUserId } } },
    include: { listing: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getOrdersForAgent(agentProfileId: string) {
  return prisma.order.findMany({
    where: { agentId: agentProfileId },
    include: { listing: { include: { publisher: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getAllOrders(filters: { status?: string; limit?: number; offset?: number }) {
  const { status, limit = 50, offset = 0 } = filters;
  return prisma.order.findMany({
    where: status ? { status: status as any } : {},
    include: { listing: true, agent: { include: { user: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export async function getSimilarListings(listingId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing) throw new Error('LISTING_NOT_FOUND');
  return prisma.listing.findMany({
    where: {
      id: { not: listingId },
      city: listing.city ?? undefined,
      category: listing.category,
      status: 'ACTIVE',
      monthlyPrice: { gte: listing.monthlyPrice * 0.7, lte: listing.monthlyPrice * 1.3 },
    },
    orderBy: { monthlyPrice: 'asc' },
    take: 5,
  });
}

export async function selfInstallCollectPrints(orderId: string, publisherUserId: string, photoUrl: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SELF_INSTALL') throw new Error('WRONG_STATUS');
  return prisma.order.update({
    where: { id: orderId },
    data: { selfInstallCollectPhotoUrl: photoUrl },
  });
}

export async function selfInstallCaptureCondition(orderId: string, publisherUserId: string, photoUrls: string[]) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SELF_INSTALL') throw new Error('WRONG_STATUS');
  return prisma.order.update({
    where: { id: orderId },
    data: { selfInstallConditionPhotoUrls: photoUrls },
  });
}

export async function selfInstallCheckIn(orderId: string, publisherUserId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SELF_INSTALL') throw new Error('WRONG_STATUS');
  return prisma.order.update({
    where: { id: orderId },
    data: { selfInstallCheckedInAt: new Date() },
  });
}

export async function selfInstallCaptureInstallation(orderId: string, publisherUserId: string, photoUrl: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { listing: { include: { publisher: true } } },
  });
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.listing.publisher?.userId !== publisherUserId) throw new Error('NOT_YOUR_ORDER');
  if (order.status !== 'SELF_INSTALL') throw new Error('WRONG_STATUS');

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: 'PENDING_APPROVAL', selfInstallInstallPhotoUrl: photoUrl },
  });

  notifyAdmins(
    'Self-install complete — review needed',
    `Order ${orderId.slice(-6).toUpperCase()} was self-installed by publisher. Please review and approve.`,
    orderId,
  ).catch(() => {});

  return updated;
}

async function notifyAdmins(title: string, message: string, relatedId: string) {
  const admins = await prisma.userRole.findMany({ where: { role: 'ADMIN' }, include: { user: true } });
  return Promise.all(admins.map((ur) =>
    createNotification({ userId: ur.userId, type: 'ORDER', title, message, relatedId }),
  ));
}
