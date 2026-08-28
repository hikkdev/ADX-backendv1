import type { Advertisement } from '../../shared/database';
import type { UpdateAdvertisementInput } from './advertisements.schema';

export type AdvertisementFilter = { advertiserId?: string };

export type NewAdvertisement = {
  advertiserId: string;
  title: string;
  description?: string;
  photoUrls: string[];
};

export interface AdvertisementRepository {
  findPage(
    where: AdvertisementFilter,
    page: number,
    pageSize: number,
  ): Promise<{ items: Advertisement[]; total: number }>;
  findById(id: string): Promise<Advertisement | null>;
  create(data: NewAdvertisement): Promise<Advertisement>;
  update(id: string, data: UpdateAdvertisementInput): Promise<Advertisement>;
  remove(id: string): Promise<unknown>;
}
