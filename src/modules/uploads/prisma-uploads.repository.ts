import { prisma } from '../../shared/database';
import type { UploadRecord, UploadsRepository } from './uploads.repository';

export const prismaUploadsRepository: UploadsRepository = {
  record(data: UploadRecord) {
    return prisma.uploadedFile.create({ data });
  },
};
