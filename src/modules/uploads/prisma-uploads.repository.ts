import { prisma } from '../../shared/database';
import type { UploadRecord, UploadsRepository } from './uploads.repository';

export const prismaUploadsRepository: UploadsRepository = {
  record(data: UploadRecord) {
    const { id, ownerUserId, storageKey, visibility, ...rest } = data;
    return prisma.uploadedFile.create({
      data: {
        ...rest,
        ...(id ? { id } : {}),
        ...(visibility ? { visibility } : {}),
        ownerUserId: ownerUserId ?? null,
        storageKey: storageKey ?? null,
      },
    });
  },
  findById(id: string) {
    return prisma.uploadedFile.findUnique({ where: { id } });
  },
  remove(id: string) {
    return prisma.uploadedFile.delete({ where: { id } });
  },
  listByUserAndPurpose(userId: string, purpose: string) {
    return prisma.uploadedFile.findMany({ where: { userId, purpose: purpose as never }, orderBy: { createdAt: 'asc' } });
  },
};
