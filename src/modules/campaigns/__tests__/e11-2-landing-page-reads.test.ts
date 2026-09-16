import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E11-2: the landing page on the campaign reads.
 *
 * `GET /campaigns/:id` carries `landingPage: { id, slug, status, url,
 * publishedAt } | null` — one narrow read through the relation, so the
 * detail screen can say "this campaign has a page, and it is live" without
 * a second call. The generate and the patch answer `url` beside the
 * blocks, the way the GET and the publish already did.
 */

const { repository, logActivity, ai, complete } = vi.hoisted(() => ({
  repository: {
    findCampaign: vi.fn(),
    findLandingPage: vi.fn(),
    landingPageSummary: vi.fn(),
    landingSlugExists: vi.fn(),
    createLandingPage: vi.fn(),
    updateLandingPage: vi.fn(),
  },
  logActivity: vi.fn(),
  ai: { assertLandingPageQuota: vi.fn(), recordLandingPageGeneration: vi.fn() },
  complete: vi.fn(),
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity,
}));
vi.mock('../../../shared/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/ai')>()),
  complete,
}));
vi.mock('../../ai', () => ai);
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../advertisers', () => ({ getAdvertiserForUser: vi.fn() }));
vi.mock('../../agents', () => ({ findAgentProfile: vi.fn() }));
vi.mock('../../pricing', () => ({ assertCityAllows: vi.fn() }));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn() }));
vi.mock('../../feature-flags', () => ({ isFeatureEnabled: vi.fn(), ...passThroughFeatureGates() }));

import { generateLandingPage, landingPageSummary, landingPageUrl, patchLandingPage, withLandingUrl } from '../landing-page.service';

const advertiser = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', agentId: null };

const campaign = () => ({
  id: 'cmp_1',
  name: 'Diwali Sale 2026',
  status: 'LIVE',
  advertiserId: 'adv_1',
  agentId: null,
  createdByUserId: 'usr_adv',
  brandName: 'Kumar Sweets',
  productName: null,
  industry: null,
  subCategory: null,
  goal: null,
  awareness: null,
  strategy: null,
  persona: null,
  targetLocation: null,
  targetMarket: 'Bengaluru',
  targetMarkets: ['Bengaluru'],
  startDate: null,
  endDate: null,
  trackingConfig: null,
  spots: [],
  pois: [],
  creatives: [],
  codes: [],
  advertiser: { id: 'adv_1', name: 'Ravi Kumar', companyName: null },
  brand: null,
});

const page = (over: Record<string, unknown> = {}) => ({
  id: 'lp_1',
  campaignId: 'cmp_1',
  slug: 'diwali-sale-2026-k7m2',
  blocks: [{ type: 'hero', headline: 'Sweeten this Diwali', subheadline: '', imageUrl: null }],
  theme: null,
  version: 1,
  status: 'DRAFT',
  generatedByAi: true,
  publishedAt: null,
  createdByUserId: 'usr_adv',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findCampaign.mockResolvedValue(campaign());
  ai.assertLandingPageQuota.mockResolvedValue({ used: 0, quota: 3, paid: false });
});

describe('GET /campaigns/:id — landingPage', () => {
  it('is the narrow summary with its url when the campaign has a page', async () => {
    const publishedAt = new Date('2026-10-01T10:00:00Z');
    repository.landingPageSummary.mockResolvedValue({ id: 'lp_1', slug: 'diwali-sale-2026-k7m2', status: 'PUBLISHED', publishedAt });
    await expect(landingPageSummary('cmp_1')).resolves.toEqual({
      id: 'lp_1',
      slug: 'diwali-sale-2026-k7m2',
      status: 'PUBLISHED',
      url: '/p/diwali-sale-2026-k7m2',
      publishedAt,
    });
    expect(repository.landingPageSummary).toHaveBeenCalledWith('cmp_1');
  });

  it('is null when there is no page', async () => {
    repository.landingPageSummary.mockResolvedValue(null);
    await expect(landingPageSummary('cmp_1')).resolves.toBeNull();
  });

  it('builds the url the public handler answers on', () => {
    expect(landingPageUrl('diwali-sale-2026-k7m2')).toBe('/p/diwali-sale-2026-k7m2');
    expect(withLandingUrl(page() as never)).toMatchObject({ slug: 'diwali-sale-2026-k7m2', url: '/p/diwali-sale-2026-k7m2' });
  });
});

describe('the generate and the patch answer url beside the blocks', () => {
  it('generate', async () => {
    repository.findLandingPage.mockResolvedValue(null);
    repository.landingSlugExists.mockResolvedValue(false);
    complete.mockResolvedValue({
      text: '{"hero":{"headline":"Sweeten this Diwali","subheadline":"Gift boxes"},"offer":{"title":"Boxes","body":"Hand-made.","highlight":""},"cta":{"label":"Order"},"contact":{"note":"Leave your number."}}',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    repository.createLandingPage.mockImplementation(async (data: { slug: string }) => page({ slug: data.slug }));

    const drafted = await generateLandingPage('cmp_1', advertiser);
    const answered = withLandingUrl(drafted);
    expect(answered.url).toBe(`/p/${drafted.slug}`);
    expect(answered.blocks).toEqual(drafted.blocks);
  });

  it('patch', async () => {
    repository.findLandingPage.mockResolvedValue(page());
    repository.updateLandingPage.mockResolvedValue(page({ version: 2 }));
    const edited = await patchLandingPage('cmp_1', advertiser, { theme: { primaryColor: '#123456' } });
    expect(withLandingUrl(edited)).toMatchObject({ version: 2, url: '/p/diwali-sale-2026-k7m2' });
  });
});
