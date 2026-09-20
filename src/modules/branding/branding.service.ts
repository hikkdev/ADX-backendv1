import { ApiError } from '../../shared/errors';
import {
  BRAND_FIELDS,
  brandChecks,
  getIntegrationsConfig,
  resolveBrand,
  updateIntegrationsConfig,
  type BrandCheck,
  type BrandingConfig,
} from '../../shared/integrations';
import { prismaBrandingRepository as repository } from './prisma-branding.repository';
import type { BrandDraftPatch } from './branding.schema';
import type { BrandManagerView, BrandReleaseRow, ReleaseSummary } from './branding.types';

/**
 * QR-11 (17 Sep 2026): the brand manager behind Settings › Brand & theme.
 *
 * The DRAFT is the integrations row's `branding` section — every save on the
 * page lands there and nobody outside the console sees it. PUBLISH freezes
 * the draft into a `BrandRelease`; the latest release is what `GET
 * /app/branding` answers, so that is the moment the console recolours and
 * the phones pick the change up at their next launch. RESTORE publishes an
 * old release's config again as a new release (the history is append-only)
 * and sets the draft to it, so the page shows what is live.
 */

const summary = (release: BrandReleaseRow, baseUrl: string, names: Map<string, string | null>, liveNumber: number | null): ReleaseSummary => {
  const brand = resolveBrand(release.config, baseUrl);
  return {
    number: release.number,
    version: release.version,
    note: release.note,
    publishedAt: release.publishedAt.toISOString(),
    publishedBy: release.publishedById ? { id: release.publishedById, name: names.get(release.publishedById) ?? null } : null,
    platformName: brand.platformName,
    tagline: brand.tagline,
    colours: { primaryColor: brand.primaryColor, deepColor: brand.deepColor, inkColor: brand.inkColor, groundColor: brand.groundColor },
    wordmarkUrl: brand.wordmarkUrl,
    markUrl: brand.markUrl,
    live: release.number === liveNumber,
  };
};

/** The draft as the page draws it: every known key, null where DR 11 is in force. */
export function draftFields(config: BrandingConfig | undefined): Record<string, string | string[] | null> {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const out: Record<string, string | string[] | null> = {};
  for (const key of BRAND_FIELDS) {
    const value = cfg[key];
    out[key] = Array.isArray(value) ? value.map(String) : typeof value === 'string' && value.trim() !== '' ? value : null;
  }
  // The two pre-QR-9 fields show through as the wordmark and the mark.
  if (out['wordmarkUrl'] === null && typeof cfg['headerLogoUrl'] === 'string') out['wordmarkUrl'] = cfg['headerLogoUrl'];
  if (out['markUrl'] === null && typeof cfg['authLogoUrl'] === 'string') out['markUrl'] = cfg['authLogoUrl'];
  return out;
}

export async function readManager(baseUrl: string): Promise<BrandManagerView> {
  const [cfg, latest] = await Promise.all([getIntegrationsConfig(), repository.latest()]);
  const draftBrand = resolveBrand(cfg.branding, baseUrl);
  const live = resolveBrand(latest?.config, baseUrl);
  const names = latest?.publishedById ? await repository.namesOf([latest.publishedById]) : new Map<string, string | null>();
  return {
    draft: draftFields(cfg.branding),
    draftBrand,
    live,
    release: latest ? summary(latest, baseUrl, names, latest.number) : null,
    dirty: draftBrand.version !== live.version,
    checks: brandChecks(draftBrand),
  };
}

/** A save on the page: the patch lands on the draft; nothing is live until Publish. */
export async function updateDraft(patch: BrandDraftPatch, baseUrl: string): Promise<BrandManagerView> {
  // An empty tagline list clears the key the way '' clears a string.
  const writable: Record<string, unknown> = { ...patch };
  if (Array.isArray(patch.taglines) && patch.taglines.length === 0) writable['taglines'] = null;
  await updateIntegrationsConfig('branding', writable);
  return readManager(baseUrl);
}

export interface Published {
  view: BrandManagerView;
  release: BrandReleaseRow;
  /** The checks that were not `ok` at publish time — for the trail. */
  flagged: BrandCheck['key'][];
}

/** Publish: the draft becomes the next release. Refused when it would change nothing. */
export async function publishDraft(userId: string, note: string | undefined, baseUrl: string): Promise<Published> {
  const [cfg, latest, highest] = await Promise.all([getIntegrationsConfig(), repository.latest(), repository.highestNumber()]);
  const draft = cfg.branding ?? {};
  const draftBrand = resolveBrand(draft, baseUrl);
  const live = resolveBrand(latest?.config, baseUrl);
  if (latest && draftBrand.version === live.version) {
    throw new ApiError(409, 'NOTHING_TO_PUBLISH', 'The draft is what is live already — change something first.');
  }
  const release = await repository.create({
    number: highest + 1,
    config: draft,
    version: draftBrand.version,
    note: note?.trim() || null,
    publishedById: userId,
  });
  const flagged = brandChecks(draftBrand).filter((c) => c.level !== 'ok').map((c) => c.key);
  return { view: await readManager(baseUrl), release, flagged };
}

export async function listReleases(page: number, pageSize: number, baseUrl: string): Promise<{ rows: ReleaseSummary[]; total: number; page: number; pageSize: number }> {
  const [{ rows, total }, latest] = await Promise.all([repository.list(page, pageSize), repository.latest()]);
  const names = await repository.namesOf(rows.map((r) => r.publishedById).filter((id): id is string => Boolean(id)));
  return { rows: rows.map((r) => summary(r, baseUrl, names, latest?.number ?? null)), total, page, pageSize };
}

/**
 * Restore: the numbered release's config becomes the draft — every field,
 * so what that release did not set is cleared — and is published again as
 * a new release. One click, one audit row, the history intact.
 */
export async function restoreRelease(userId: string, number: number, baseUrl: string): Promise<{ view: BrandManagerView; release: BrandReleaseRow; from: BrandReleaseRow }> {
  const from = await repository.findByNumber(number);
  if (!from) throw new ApiError(404, 'NOT_FOUND', `No brand release #${number}`);
  const cfg = from.config as Record<string, unknown>;
  const full: Record<string, unknown> = {};
  for (const key of BRAND_FIELDS) {
    const value = cfg[key];
    full[key] = value === undefined || value === '' ? null : value;
  }
  await updateIntegrationsConfig('branding', full);
  const highest = await repository.highestNumber();
  const brand = resolveBrand(from.config, baseUrl);
  const release = await repository.create({
    number: highest + 1,
    config: from.config,
    version: brand.version,
    note: `Restored release #${from.number}${from.note ? ` — ${from.note}` : ''}`,
    publishedById: userId,
  });
  return { view: await readManager(baseUrl), release, from };
}
