import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-11 — the brand manager: a draft that is not live, Publish that makes
 * it so, a history that only grows, Restore that republishes, and the
 * legibility checks on the draft.
 */

const { repository, config } = vi.hoisted(() => ({
  repository: {
    latest: vi.fn(),
    findByNumber: vi.fn(),
    highestNumber: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    namesOf: vi.fn(),
  },
  config: { branding: {} as Record<string, unknown> },
}));

vi.mock('../prisma-branding.repository', () => ({ prismaBrandingRepository: repository }));
vi.mock('../../../shared/integrations/integration-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations/integration-config')>();
  return {
    ...actual,
    getIntegrationsConfig: vi.fn(async () => ({ branding: { ...config.branding } })),
    updateIntegrationsConfig: vi.fn(async (_section: string, patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete config.branding[key];
        else if (value !== undefined && value !== '') config.branding[key] = value;
      }
      return { branding: { ...config.branding } };
    }),
  };
});

import { brandChecks, contrastRatio, onPrimaryFor, resolveBrand } from '../../../shared/integrations/branding';
import { listReleases, publishDraft, readManager, restoreRelease, updateDraft } from '../branding.service';

const BASE = 'http://api';

const release = (number: number, cfg: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: `rel_${number}`,
  number,
  config: cfg,
  version: resolveBrand(cfg, BASE).version,
  note: null,
  publishedById: 'usr_admin',
  publishedAt: new Date('2026-09-17T06:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  config.branding = {};
  repository.latest.mockResolvedValue(null);
  repository.highestNumber.mockResolvedValue(0);
  repository.namesOf.mockResolvedValue(new Map([['usr_admin', 'Admin One']]));
  // The fake table: a created release is the latest one from then on.
  repository.create.mockImplementation(async (data: { number: number; config: Record<string, unknown>; version: string; note: string | null; publishedById: string | null }) => {
    const made = release(data.number, data.config, { version: data.version, note: data.note, publishedById: data.publishedById });
    repository.latest.mockResolvedValue(made);
    repository.highestNumber.mockResolvedValue(made.number);
    return made;
  });
});

describe('the resolved brand', () => {
  it('carries the website kit and what is written on the primary, and hashes them into the version', () => {
    const dr11 = resolveBrand(undefined, BASE);
    expect(dr11.onPrimaryColor).toBe('#FFFFFF');
    expect(dr11.website).toEqual({
      taglines: ['Space that gets seen.', 'Own the city.', 'Real world. Real reach.'],
      heroImageUrl: null,
      ogImageUrl: null,
      faviconUrl: 'http://api/brand/adx-icon-tile.svg',
      title: 'ADX — Space that gets seen.',
      description: expect.stringContaining('Real-world ad space'),
    });
    // QR-12: the per-surface basics, DR 11's until set.
    expect(dr11.apps).toEqual({ iconUrl: null });
    expect(dr11.console).toEqual({ title: 'ADX Admin' });
    const surfaced = resolveBrand({ appIconUrl: 'https://cdn/icon-1024.png', consoleTitle: 'ADX Ops', siteTitle: 'ADX', siteDescription: 'Space.' }, BASE);
    expect(surfaced.apps.iconUrl).toBe('https://cdn/icon-1024.png');
    expect(surfaced.console.title).toBe('ADX Ops');
    expect(surfaced.website.title).toBe('ADX');
    expect(surfaced.defaults).not.toContain('apps.appIconUrl');
    expect(surfaced.version).not.toBe(dr11.version);
    expect(dr11.defaults).toEqual(expect.arrayContaining(['website.taglines', 'website.heroImageUrl', 'website.ogImageUrl', 'website.faviconUrl']));

    const kit = resolveBrand({ taglines: ['Own the city.'], heroImageUrl: 'https://cdn/hero.jpg' }, BASE);
    expect(kit.website.taglines).toEqual(['Own the city.']);
    expect(kit.website.heroImageUrl).toBe('https://cdn/hero.jpg');
    expect(kit.defaults).not.toContain('website.taglines');
    expect(kit.version).not.toBe(dr11.version);

    // A pale primary writes the ink on it.
    expect(onPrimaryFor('#F5D400', '#0F0F0F')).toBe('#0F0F0F');
    expect(resolveBrand({ primaryColor: '#F5D400' }, BASE).onPrimaryColor).toBe('#0F0F0F');
  });

  it('grades legibility against the two WCAG bars', () => {
    const ok = brandChecks(resolveBrand(undefined, BASE));
    expect(ok.map((c) => `${c.key}:${c.level}`)).toEqual(['text-on-primary:ok', 'primary-on-ground:ok', 'ink-on-ground:ok', 'white-on-deep:ok']);
    expect(ok[0]!.ratio).toBe(Math.round(contrastRatio('#FFFFFF', '#E40209') * 10) / 10);

    // A pastel primary on a pale ground: the label is written in ink and passes, the links fail.
    const pastel = brandChecks(resolveBrand({ primaryColor: '#F7C6C7', groundColor: '#FFFFFF' }, BASE));
    expect(pastel.find((c) => c.key === 'primary-on-ground')!.level).toBe('fail');
    expect(pastel.find((c) => c.key === 'text-on-primary')!.level).toBe('ok');

    // Grey ink on the ground: body text fails.
    const faint = brandChecks(resolveBrand({ inkColor: '#9A9A9A' }, BASE));
    expect(faint.find((c) => c.key === 'ink-on-ground')!.level).toBe('fail');
  });
});

describe('the manager', () => {
  it('reads a draft that is not live: DR 11 stays live until the first publish, and the view says the draft differs', async () => {
    config.branding = { primaryColor: '#123456', taglines: ['Own the city.'] };
    const view = await readManager(BASE);
    expect(view.live.primaryColor).toBe('#E40209');
    expect(view.draftBrand.primaryColor).toBe('#123456');
    expect(view.draft['primaryColor']).toBe('#123456');
    expect(view.draft['taglines']).toEqual(['Own the city.']);
    expect(view.draft['deepColor']).toBeNull();
    expect(view.release).toBeNull();
    expect(view.dirty).toBe(true);
    expect(view.checks).toHaveLength(4);
  });

  it('a save lands on the draft only; an empty tagline list clears the kit', async () => {
    const saved = await updateDraft({ primaryColor: '#8D0B0C', taglines: ['One', 'Two'] }, BASE);
    expect(config.branding).toEqual({ primaryColor: '#8D0B0C', taglines: ['One', 'Two'] });
    expect(saved.live.primaryColor).toBe('#E40209');
    await updateDraft({ taglines: [] }, BASE);
    expect(config.branding).toEqual({ primaryColor: '#8D0B0C' });
  });

  it('publish freezes the draft as the next release and refuses when nothing would change', async () => {
    config.branding = { primaryColor: '#8D0B0C' };
    const { view, release: made, flagged } = await publishDraft('usr_admin', ' Darker red ', BASE);
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ number: 1, config: { primaryColor: '#8D0B0C' }, note: 'Darker red', publishedById: 'usr_admin' }));
    expect(made.number).toBe(1);
    expect(flagged).toEqual([]);

    // Now the release is live: the view says so.
    const after = await readManager(BASE);
    expect(after.live.primaryColor).toBe('#8D0B0C');
    expect(after.release).toEqual(expect.objectContaining({ number: 1, live: true, publishedBy: { id: 'usr_admin', name: 'Admin One' } }));
    expect(after.dirty).toBe(false);
    expect(view.dirty).toBe(false);

    await expect(publishDraft('usr_admin', undefined, BASE)).rejects.toMatchObject({ statusCode: 409, code: 'NOTHING_TO_PUBLISH' });
  });

  it('publish records the checks it shipped with', async () => {
    config.branding = { primaryColor: '#F7C6C7' };
    const { flagged } = await publishDraft('usr_admin', undefined, BASE);
    expect(flagged).toContain('primary-on-ground');
  });

  it('the history lists the releases newest first with the live one marked', async () => {
    const one = release(1, { primaryColor: '#8D0B0C' });
    const two = release(2, {}, { note: 'Back to DR 11' });
    repository.list.mockResolvedValue({ rows: [two, one], total: 2 });
    repository.latest.mockResolvedValue(two);
    const page = await listReleases(1, 20, BASE);
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => [r.number, r.live, r.colours.primaryColor])).toEqual([
      [2, true, '#E40209'],
      [1, false, '#8D0B0C'],
    ]);
    expect(page.rows[1]!.publishedBy).toEqual({ id: 'usr_admin', name: 'Admin One' });
  });

  it('restore copies the old release onto the draft in full and publishes it again', async () => {
    config.branding = { primaryColor: '#123456', tagline: 'Something new', taglines: ['x'] };
    const one = release(1, { primaryColor: '#8D0B0C' });
    repository.findByNumber.mockResolvedValue(one);
    repository.highestNumber.mockResolvedValue(3);
    const { release: made, from } = await restoreRelease('usr_admin', 1, BASE);
    // Every key the old release did not set is cleared: the draft IS release 1.
    expect(config.branding).toEqual({ primaryColor: '#8D0B0C' });
    expect(from.number).toBe(1);
    expect(made.number).toBe(4);
    expect(made.note).toBe('Restored release #1');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ number: 4, config: { primaryColor: '#8D0B0C' } }));

    repository.findByNumber.mockResolvedValue(null);
    await expect(restoreRelease('usr_admin', 9, BASE)).rejects.toMatchObject({ statusCode: 404 });
  });
});
