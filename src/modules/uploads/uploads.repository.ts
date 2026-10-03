import type { FileVisibility, Prisma, UploadedFile } from '../../shared/database';
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
  /** GC-1: the fix the photo was stamped with, when it asked for one. */
  geo?: { latitude: number; longitude: number; accuracyM: number | null; takenAt: Date } | null;
};

export interface UploadsRepository {
  record(data: UploadRecord): Promise<UploadedFile>;
  findById(id: string): Promise<UploadedFile | null>;
  /** DR-1: the row behind a public URL of ours — a listing's document is known to the desk by its URL alone. */
  findByUrl(url: string): Promise<UploadedFile | null>;
  remove(id: string): Promise<unknown>;
  /** QR-7: every file a person uploaded for a purpose — the previous avatars, to purge. */
  listByUserAndPurpose(userId: string, purpose: string): Promise<UploadedFile[]>;
  /** DR-1: the reading kept on the file — the kind it was read as, the fields, when and by whom. */
  recordReading(id: string, data: { readingKind: string; reading: Prisma.InputJsonValue; readAt: Date; readByUserId: string }): Promise<UploadedFile>;
  /**
   * ST-2: the row whose URL or storage key ends this way — an object's own
   * name, for a URL recorded on another host (a phone's 10.0.2.2, a desk's
   * localhost), or for the public URL of a file since moved private (its key
   * keeps the name).
   */
  findByNameEnding(suffix: string): Promise<UploadedFile | null>;
  /** ST-1/ST-2: where a stored file now is and what it is — a rewrite in place (the size), or an adoption (purpose, visibility, key, URL). */
  updateStored(id: string, data: StoredFilePatch): Promise<UploadedFile>;
  /** ST-1: a page of PUBLIC rows of these types, in id order after `afterId` — the strip-existing walk. */
  listPublicByMime(mimeTypes: readonly string[], afterId: string | null, take: number): Promise<UploadedFile[]>;
}

export type StoredFilePatch = {
  purpose?: UploadPurpose;
  visibility?: FileVisibility;
  storageKey?: string | null;
  url?: string;
  sizeBytes?: number;
};
