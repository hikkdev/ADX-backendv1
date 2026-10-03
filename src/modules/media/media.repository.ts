import type { MediaAsset, MediaFilter, MediaPatch, MediaUsage, NewMedia, OpenAdBooking } from './media.types';

export interface MediaRepository {
  list(filter: MediaFilter): Promise<MediaAsset[]>;
  findById(id: string): Promise<MediaAsset | null>;
  findByIds(ids: string[]): Promise<MediaAsset[]>;
  create(data: NewMedia): Promise<MediaAsset>;
  update(id: string, patch: MediaPatch): Promise<MediaAsset>;
  setArchived(id: string, at: Date | null): Promise<MediaAsset>;
  /** Every block of a PUBLISHED layout that draws this picture. */
  publishedUsage(mediaId: string): Promise<MediaUsage[]>;
  /** Every display-ad booking not yet ENDED / REJECTED / CANCELLED that names this picture as its artwork. */
  openAdBookings(mediaId: string): Promise<OpenAdBooking[]>;
}
