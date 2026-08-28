import type { UploadedFile } from '../../shared/database';
import type { UploadPurpose } from './uploads.schema';

export type UploadRecord = {
  userId: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  purpose: UploadPurpose;
};

export interface UploadsRepository {
  record(data: UploadRecord): Promise<UploadedFile>;
}
