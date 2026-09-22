import { prisma } from '../../shared/database';
import type { TrailKind } from '../../shared/database';
import type { AgentLocationsRepository, AgentSummary, NewPoint, OrderTimelineFacts, TripContext } from './agent-locations.repository';
import type { LatLng } from './agent-locations.rules';

const point = (latitude: number | null, longitude: number | null): LatLng | null => (latitude !== null && longitude !== null ? { latitude, longitude } : null);

const shortId = (id: string) => id.slice(-6).toUpperCase();

/** The lane's statuses that mean the agent is (still) on the way — anything else closes the trip. */
const OPEN_ORDER_STATUSES = new Set(['SLOT_PROPOSED', 'SLOT_CONFIRMED', 'IN_PROGRESS', 'PENDING_OTP']);
const OPEN_MILESTONE_STATUSES = new Set(['DISPATCHED', 'IN_PROGRESS']);
const OPEN_VISIT_STATUSES = new Set(['SCHEDULED', 'IN_PROGRESS']);

const agentSelect = {
  id: true,
  displayId: true,
  userId: true,
  city: true,
  status: true,
  stage: true,
  user: { select: { name: true, mobile: true, roles: { select: { role: true } } } },
} as const;

function shapeAgent(row: { id: string; displayId: string | null; userId: string; city: string | null; status: string; stage: string; user: { name: string | null; mobile: string; roles: { role: string }[] } }): AgentSummary {
  const sides: AgentSummary['sides'] = [];
  if (row.user.roles.some((r) => r.role === 'AGENT_PUBLISHER')) sides.push('PUBLISHER');
  if (row.user.roles.some((r) => r.role === 'AGENT_ADVERTISER')) sides.push('ADVERTISER');
  return { id: row.id, displayId: row.displayId, userId: row.userId, name: row.user.name ?? row.user.mobile, mobile: row.user.mobile, city: row.city, sides, status: row.status, stage: row.stage };
}

export const prismaAgentLocationsRepository: AgentLocationsRepository = {
  async tripContext(kind, id) {
    if (kind === 'ORDER') {
      const order = await prisma.order.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          agentId: true,
          slotTime: true,
          listing: { select: { title: true, latitude: true, longitude: true } },
        },
      });
      if (!order) return null;
      // PrintJob hangs off the order by a bare unique column, not a relation.
      const printJob = await prisma.printJob.findUnique({ where: { orderId: id }, select: { readyAt: true, handoverConfirmedAt: true, printPartner: { select: { id: true, name: true, latitude: true, longitude: true } } } });
      const pickup = printJob
        ? {
            partnerId: printJob.printPartner.id,
            name: printJob.printPartner.name,
            point: point(printJob.printPartner.latitude, printJob.printPartner.longitude),
            readyAt: printJob.readyAt,
            handoverAt: printJob.handoverConfirmedAt,
          }
        : null;
      // The first leg is the shop until the handover scan; then the site.
      const toPickup = pickup !== null && pickup.handoverAt === null && pickup.point !== null;
      return {
        kind,
        id: order.id,
        orderId: order.id,
        agentId: order.agentId,
        label: toPickup ? `Pickup at ${pickup.name}` : `Install at ${order.listing.title}`,
        destination: toPickup ? pickup.point : point(order.listing.latitude, order.listing.longitude),
        slotAt: order.slotTime,
        open: OPEN_ORDER_STATUSES.has(order.status),
        pickup,
      };
    }
    if (kind === 'MILESTONE') {
      const milestone = await prisma.orderMilestone.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          orderId: true,
          assignedAgentId: true,
          scheduledStart: true,
          template: { select: { title: true } },
          orderRecord: { select: { listing: { select: { title: true, latitude: true, longitude: true } } } },
        },
      });
      if (!milestone) return null;
      return {
        kind,
        id: milestone.id,
        orderId: milestone.orderId,
        agentId: milestone.assignedAgentId,
        label: `${milestone.template.title} at ${milestone.orderRecord.listing.title}`,
        destination: point(milestone.orderRecord.listing.latitude, milestone.orderRecord.listing.longitude),
        slotAt: milestone.scheduledStart,
        open: OPEN_MILESTONE_STATUSES.has(milestone.status),
        pickup: null,
      };
    }
    const visit = await prisma.fieldVisit.findUnique({
      where: { id },
      select: { id: true, status: true, agentId: true, businessName: true, locality: true, latitude: true, longitude: true, scheduledFor: true },
    });
    if (!visit) return null;
    return {
      kind,
      id: visit.id,
      orderId: null,
      agentId: visit.agentId,
      label: `Visit ${visit.businessName}${visit.locality ? `, ${visit.locality}` : ''}`,
      destination: point(visit.latitude, visit.longitude),
      slotAt: visit.scheduledFor,
      open: OPEN_VISIT_STATUSES.has(visit.status),
      pickup: null,
    };
  },

  async agentSummaries(ids) {
    if (ids.length === 0) return [];
    const rows = await prisma.agentProfile.findMany({ where: { id: { in: [...ids] } }, select: agentSelect });
    return rows.map(shapeAgent);
  },

  async activeAgents(filter) {
    const rows = await prisma.agentProfile.findMany({
      where: { stage: 'ACTIVE', ...(filter.city ? { city: { equals: filter.city, mode: 'insensitive' } } : {}) },
      select: agentSelect,
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return rows.map(shapeAgent);
  },

  findTrail: (agentId, kind, contextId) => prisma.agentTrail.findUnique({ where: { agentId_kind_contextId: { agentId, kind, contextId } } }),

  openTrail: (data) =>
    prisma.agentTrail.create({
      data: {
        agentId: data.agentId,
        kind: data.kind,
        contextId: data.contextId,
        orderId: data.orderId,
        destinationLat: data.destination?.latitude ?? null,
        destinationLng: data.destination?.longitude ?? null,
        destinationLabel: data.destinationLabel,
        startedAt: data.startedAt,
        lastFixAt: data.startedAt,
      },
    }),

  lastPoint: (trailId) => prisma.agentLocationPoint.findFirst({ where: { trailId }, orderBy: { at: 'desc' } }),

  async appendPoint(trailId, p, distanceM) {
    await prisma.$transaction([
      prisma.agentLocationPoint.create({ data: { trailId, agentId: p.agentId, latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, speed: p.speed, heading: p.heading, at: p.at } }),
      prisma.agentTrail.update({ where: { id: trailId }, data: { pointCount: { increment: 1 }, distanceM: { increment: distanceM }, lastFixAt: p.at } }),
    ]);
  },

  async touchTrail(trailId, patch) {
    await prisma.agentTrail.update({ where: { id: trailId }, data: patch });
  },

  points: (trailId, limit) => prisma.agentLocationPoint.findMany({ where: { trailId }, orderBy: { at: 'asc' }, take: limit }),

  trailsForOrder: (orderId) => prisma.agentTrail.findMany({ where: { orderId }, orderBy: { startedAt: 'asc' } }),

  openTrailsFor: (agentId) => prisma.agentTrail.findMany({ where: { agentId, endedAt: null }, orderBy: { startedAt: 'desc' } }),

  async purgeBefore(cut) {
    const points = await prisma.agentLocationPoint.deleteMany({ where: { at: { lt: cut } } });
    const trails = await prisma.agentTrail.deleteMany({ where: { lastFixAt: { lt: cut } } });
    return { trails: trails.count, points: points.count };
  },

  async orderTimelineFacts(orderId): Promise<OrderTimelineFacts | null> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        agentId: true,
        slotTime: true,
        printReadyAt: true,
        updatedAt: true,
        listing: { select: { title: true, latitude: true, longitude: true } },
        milestones: { where: { template: { type: 'INSTALLATION' } }, select: { status: true, startedAt: true, completedAt: true }, orderBy: { order: 'asc' }, take: 1 },
      },
    });
    if (!order) return null;
    const printJob = await prisma.printJob.findUnique({ where: { orderId }, select: { readyAt: true, handoverConfirmedAt: true, printPartner: { select: { name: true, latitude: true, longitude: true } } } });
    const installation = order.milestones[0] ?? null;
    return {
      id: order.id,
      reference: shortId(order.id),
      status: order.status,
      agentId: order.agentId,
      slotTime: order.slotTime,
      printReadyAt: order.printReadyAt,
      site: { title: order.listing.title, point: point(order.listing.latitude, order.listing.longitude) },
      printJob: printJob
        ? { partnerName: printJob.printPartner.name, point: point(printJob.printPartner.latitude, printJob.printPartner.longitude), readyAt: printJob.readyAt, handoverAt: printJob.handoverConfirmedAt }
        : null,
      installation: installation ? { status: installation.status, startedAt: installation.startedAt, completedAt: installation.completedAt } : null,
      completedAt: order.status === 'COMPLETED' ? order.updatedAt : null,
    };
  },
};

export type { TrailKind };
