import type { FileVisibility, UploadedFile } from '../../shared/database';
import type { UploadPurpose } from './uploads.schema';

export type UploadRecord = {
  /** A caller-minted id, so a private file's URL can name it before the row exists. */
  id?: string;
  userId: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  purpose: UploadPurpose;
  /** Lot D (Q61). PUBLIC unless the purpose is one of `PRIVATE_PURPOSES`. */
  visibility?: FileVisibility;
  /** The party whose document this is when the uploader is not them — an agent, an admin at the desk. */
  ownerUserId?: string | null;
  storageKey?: string | null;
};

export interface UploadsRepository {
  record(data: UploadRecord): Promise<UploadedFile>;
  findById(id: string): Promise<UploadedFile | null>;
  remove(id: string): Promise<unknown>;
  /** QR-7: every file a person uploaded for a purpose — the previous avatars, to purge. */
  listByUserAndPurpose(userId: string, purpose: string): Promise<UploadedFile[]>;
}
