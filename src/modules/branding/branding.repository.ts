import type { BrandReleaseRow, NewRelease } from './branding.types';

export interface BrandingRepository {
  /** The latest release, or null before the first Publish. */
  latest(): Promise<BrandReleaseRow | null>;
  findByNumber(number: number): Promise<BrandReleaseRow | null>;
  highestNumber(): Promise<number>;
  list(page: number, pageSize: number): Promise<{ rows: BrandReleaseRow[]; total: number }>;
  create(data: NewRelease): Promise<BrandReleaseRow>;
  /** The names behind `publishedById`, for the history. */
  namesOf(userIds: string[]): Promise<Map<string, string | null>>;
}
