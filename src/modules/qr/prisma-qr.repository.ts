import { prisma } from '../../shared/database';
import type { NewQrScan, QrRepository } from './qr.repository';

export const prismaQrRepository: QrRepository = {
  createPlaceholder({ type, refId, allowedRoles, metadata, token }) {
    return prisma.qrCode.create({
      data: {
        type,
        refId,
        allowedRoles,
        ...(metadata ? { metadata: metadata as any } : {}),
        token,
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

  findScans(qrId: string) {
    return prisma.qrScan.findMany({
      where: { qrId },
      include: { scannedBy: { select: { id: true, name: true, mobile: true } } },
      orderBy: { createdAt: 'desc' },
    });
  },
};
