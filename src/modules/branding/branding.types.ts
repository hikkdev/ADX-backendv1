import type { BrandingConfig } from '../../shared/integrations';
import type { Brand, BrandCheck } from '../../shared/integrations';

/** One published brand, as the history lists it. */
export interface BrandReleaseRow {
  id: string;
  number: number;
  config: BrandingConfig;
  version: string;
  note: string | null;
  publishedById: string | null;
  publishedAt: Date;
}

export interface NewRelease {
  number: number;
  config: BrandingConfig;
  version: string;
  note: string | null;
  publishedById: string | null;
}

/** A release as the console draws it in the history: who, when, and enough of the brand to recognise it. */
export interface ReleaseSummary {
  number: number;
  version: string;
  note: string | null;
  publishedAt: string;
  publishedBy: { id: string; name: string | null } | null;
  /** The resolved brand's recognisable parts. */
  platformName: string;
  tagline: string;
  colours: { primaryColor: string; deepColor: string; inkColor: string; groundColor: string };
  wordmarkUrl: string;
  markUrl: string;
  /** True on the release every surface is drawing now. */
  live: boolean;
}

/** What Settings › Brand & theme reads: the draft, the live brand, and whether they differ. */
export interface BrandManagerView {
  /** The draft as stored — overrides only; null where DR 11 is in force. */
  draft: Record<string, string | string[] | null>;
  /** The draft resolved: what Publish would make live. */
  draftBrand: Brand;
  /** What every surface draws now. */
  live: Brand;
  /** The live release, or null while DR 11 is live because nothing was ever published. */
  release: ReleaseSummary | null;
  /** The draft differs from the live brand — there is something to publish. */
  dirty: boolean;
  /** Legibility of the DRAFT — what publishing would ship. */
  checks: BrandCheck[];
}
