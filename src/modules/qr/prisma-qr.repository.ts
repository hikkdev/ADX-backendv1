import { prisma } from '../../shared/database';
import type { Prisma } from '../../shared/database';
import type { NewQrScan, QrDeskFilter, QrRepository } from './qr.repository';

/** K-B1: the desk's where-clause, shared by the page and the chip counts. */
function deskWhere(filter: QrDeskFilter): Prisma.QrCodeWhereInput {
  return {
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.active === undefined ? {} : { isActive: filter.active }),
    ...(filter.refId ? { refId: filter.refId } : {}),
    ...(filter.q ? { OR: [{ refId: { contains: filter.q, mode: 'insensitive' } }, { id: { contains: filter.q } }] } : {}),
  };
}

export const prismaQrRepository: QrRepository = {
  createPlaceholder({ type, refId, allowedRoles, metadata, token, expiresAt, latitude, longitude }) {
    return prisma.qrCode.create({
      data: {
        type,
        refId,
        allowedRoles,
        ...(metadata ? { metadata: metadata as any } : {}),
        token,
        expiresAt,
        latitude,
        longitude,
      },
    });
  },

  setToken(qrId: string, token: string) {
    return prisma.qrCode.update({ where: { id: qrId }, data: { token } });
  },

  findById(qrId: string) {
    return prisma.qrCode.findUnique({ where: { id: qrId } });
  },

  findActiveForSubject(type, refId: string) {
    return prisma.qrCode.findFirst({ where: { type, refId, isActive: true } });
  },

  deactivateForSubject(type, refId: string) {
    return prisma.qrCode.updateMany({
      where: { type, refId, isActive: true },
      data: { isActive: false },
    });
  },

  deactivate(qrId: string) {
    return prisma.qrCode.update({ where: { id: qrId }, data: { isActive: false } });
  },

  logScan(data: NewQrScan) {
    return prisma.qrScan.create({ data });
  },

  findScanById(scanId: string) {
    return prisma.qrScan.findUnique({ where: { id: scanId } });
  },

  findPendingScan(qrId: string) {
    return prisma.qrScan.findFirst({
      where: { qrId, outcome: 'PENDING_APPROVAL' },
      orderBy: { createdAt: 'desc' },
    });
  },

  updateScan(scanId: string, data: { outcome: string; decidedAt?: Date; grantId?: string }) {
    return prisma.qrScan.update({ where: { id: scanId }, data });
  },

  /* ── K-B1: the desk ───────────────────────────────────────── */

  async findDeskPage(filter, page) {
    const where = deskWhere(filter);
    const [rows, total] = await Promise.all([
      prisma.qrCode.findMany({
        where,
        include: {
          _count: { select: { scans: true } },
          scans: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      prisma.qrCode.count({ where }),
    ]);
    return {
      rows: rows.map(({ _count, scans, ...code }) => ({ ...code, scansCount: _count.scans, lastScanAt: scans[0]?.createdAt ?? null })),
      total,
    };
  },

  async countDeskByType(filter) {
    const groups = await prisma.qrCode.groupBy({ by: ['type'], where: deskWhere(filter), _count: { _all: true } });
    return groups.map((group) => ({ type: group.type, count: group._count._all }));
  },

  async findScansPage(qrId, filter, page) {
    const where = { qrId, ...(filter.outcome ? { outcome: filter.outcome } : {}) };
    const [rows, total, groups] = await Promise.all([
      prisma.qrScan.findMany({
        where,
        include: { scannedBy: { select: { id: true, name: true, mobile: true } } },
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
      }),
      prisma.qrScan.count({ where }),
      prisma.qrScan.groupBy({ by: ['outcome'], where: { qrId }, _count: { _all: true } }),
    ]);
    const counts: Record<string, number> = {};
    for (const group of groups) counts[group.outcome] = group._count._all;
    return { rows, total, counts };
  },

  findScansByScannerFiltered({ scannedById, outcome, from, to }) {
    return prisma.qrScan.findMany({
      where: {
        scannedById,
        ...(outcome ? { outcome } : {}),
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      include: { qr: { select: { id: true, type: true, refId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  },

  findScans(qrId: string) {
    return prisma.qrScan.findMany({
      where: { qrId },
      include: { scannedBy: { select: { id: true, name: true, mobile: true } } },
      orderBy: { createdAt: 'desc' },
    });
  },

  findScansByScanner(userId: string) {
    return prisma.qrScan.findMany({
      where: { scannedById: userId },
      include: { qr: { select: { id: true, type: true, refId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  },

  findScansForSubject(type, refId) {
    return prisma.qrScan.findMany({
      where: { qr: { type, refId } },
      include: {
        scannedBy: {
          select: { id: true, name: true, mobile: true, agentProfile: { select: { displayId: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  },
};
