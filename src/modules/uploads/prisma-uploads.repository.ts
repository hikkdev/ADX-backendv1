import { prisma } from '../../shared/database';
import type { UploadRecord, UploadsRepository } from './uploads.repository';

export const prismaUploadsRepository: UploadsRepository = {
  record(data: UploadRecord) {
    const { id, ownerUserId, storageKey, visibility, geo, ...rest } = data;
    return prisma.uploadedFile.create({
      data: {
        ...rest,
        ...(id ? { id } : {}),
        ...(visibility ? { visibility } : {}),
        ownerUserId: ownerUserId ?? null,
        storageKey: storageKey ?? null,
        // GC-1: the same facts the stamp burned in, queryable on the row.
        ...(geo ? { latitude: geo.latitude, longitude: geo.longitude, accuracyM: geo.accuracyM, takenAt: geo.takenAt, geoStamped: true } : {}),
      },
    });
  },
  findById(id: string) {
    return prisma.uploadedFile.findUnique({ where: { id } });
  },
  findByUrl(url: string) {
    return prisma.uploadedFile.findFirst({ where: { url }, orderBy: { createdAt: 'desc' } });
  },
  remove(id: string) {
    return prisma.uploadedFile.delete({ where: { id } });
  },
  listByUserAndPurpose(userId: string, purpose: string) {
    return prisma.uploadedFile.findMany({ where: { userId, purpose: purpose as never }, orderBy: { createdAt: 'asc' } });
  },
  recordReading(id, data) {
    return prisma.uploadedFile.update({ where: { id }, data });
  },
  findByNameEnding(suffix: string) {
    return prisma.uploadedFile.findFirst({
      where: { OR: [{ url: { endsWith: suffix } }, { storageKey: { endsWith: suffix } }] },
      orderBy: { createdAt: 'desc' },
    });
  },
  updateStored(id, data) {
    return prisma.uploadedFile.update({ where: { id }, data });
  },
  listPublicByMime(mimeTypes, afterId, take) {
    return prisma.uploadedFile.findMany({
      where: { visibility: 'PUBLIC', mimeType: { in: [...mimeTypes] }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take,
    });
  },
};
