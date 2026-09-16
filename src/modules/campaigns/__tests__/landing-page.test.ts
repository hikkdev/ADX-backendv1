import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot E (Q7/Q106): the landing page a printed QR leads to.
 *
 * The builder drafts five blocks from the brief through the configured
 * model, the advertiser edits and publishes, and the backend renders the
 * page itself — one document, no external asset, with a beacon that
 * reports VIEW, CTA_CLICK and FORM_SUBMIT to the code the scan appended.
 * `/t/:code` sends a scan there when the advertiser gave no destination.
 * Q139: nothing on the page asks the visitor's age.
 */

const { repository, complete, logActivity, createNotification, advertisers, agents, ai } = vi.hoisted(() => ({
  ai: { assertLandingPageQuota: vi.fn(), recordLandingPageGeneration: vi.fn() },
  repository: {
    findCampaign: vi.fn(),
    findCampaignBare: vi.fn(),
    findLandingPage: vi.fn(),
    findLandingPageView: vi.fn(),
    findPublishedLandingPageBySlug: vi.fn(),
    landingSlugExists: vi.fn(),
    createLandingPage: vi.fn(),
    updateLandingPage: vi.fn(),
    listLandingPages: vi.fn(),
    findTrackingCode: vi.fn(),
    recordTrackingEvent: vi.fn(),
    bumpTrackingCounter: vi.fn(),
  },
  complete: vi.fn(),
  logActivity: vi.fn(),
  createNotification: vi.fn(),
  advertisers: { getAdvertiserForUser: vi.fn() },
  agents: { findAgentProfile: vi.fn() },
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../../shared/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/ai')>()),
  complete,
}));
vi.mock('../../../shared/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/audit')>()),
  logActivity,
}));
vi.mock('../../notifications', () => ({ createNotification }));
vi.mock('../../ai', () => ai);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../agents', () => agents);
vi.mock('../../pricing', () => ({ assertCityAllows: vi.fn() }));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn() }));
vi.mock('../../feature-flags', () => ({ isFeatureEnabled: vi.fn(), ...passThroughFeatureGates() }));

import { AiUnavailableError } from '../../../shared/ai';
import {
  blocksFrom,
  extractJson,
  generateLandingPage,
  patchLandingPage,
  publishLandingPage,
  renderLandingPage,
  slugBase,
  unpublishLandingPage,
} from '../landing-page.service';
import { resolveScan } from '../tracking.service';
import { landingPagePatchSchema } from '../campaigns.schema';

const advertiser = { userId: 'usr_adv', isAdmin: false, advertiserId: 'adv_1', agentId: null };
const stranger = { userId: 'usr_x', isAdmin: false, advertiserId: 'adv_9', agentId: null };

const campaign = (over: Record<string, unknown> = {}) => ({
  id: 'cmp_1',
  name: 'Diwali Sale 2026',
  status: 'LIVE',
  advertiserId: 'adv_1',
  agentId: null,
  createdByUserId: 'usr_adv',
  brandName: 'Kumar Sweets',
  productName: 'Festive gift boxes',
  industry: 'Food',
  subCategory: 'Confectionery',
  goal: 'FOOT_TRAFFIC',
  awareness: null,
  strategy: null,
  persona: null,
  targetLocation: 'Indiranagar, Bengaluru',
  targetMarket: 'Bengaluru',
  targetMarkets: ['Bengaluru'],
  startDate: new Date('2026-10-20T00:00:00Z'),
  endDate: new Date('2026-11-05T00:00:00Z'),
  trackingConfig: null,
  spots: [],
  pois: [],
  creatives: [],
  codes: [],
  advertiser: { id: 'adv_1', name: 'Ravi Kumar', companyName: 'Kumar Sweets Pvt Ltd' },
  brand: null,
  ...over,
});

const page = (over: Record<string, unknown> = {}) => ({
  id: 'lp_1',
  campaignId: 'cmp_1',
  slug: 'diwali-sale-2026-k7m2',
  blocks: [
    { type: 'hero', headline: 'Sweeten this Diwali', subheadline: 'Gift boxes from Kumar Sweets' },
    { type: 'offer', title: 'Festive gift boxes', body: 'Hand-made, boxed the same day.' },
    { type: 'cta', label: 'Order a box', href: null },
    { type: 'contact', note: 'Leave your number.', formEnabled: true },
    { type: 'gallery', images: [], placeholders: 3 },
  ],
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

const MODEL_ANSWER = JSON.stringify({
  hero: { headline: 'Sweeten this Diwali', subheadline: 'Gift boxes from Kumar Sweets' },
  offer: { title: 'Festive gift boxes', body: 'Hand-made, boxed the same day.', highlight: 'Now taking orders' },
  cta: { label: 'Order a box' },
  contact: { note: 'Leave your number and we will call you back.' },
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findCampaign.mockResolvedValue(campaign());
  repository.findCampaignBare.mockResolvedValue(campaign());
  repository.findLandingPage.mockResolvedValue(null);
  repository.landingSlugExists.mockResolvedValue(false);
  repository.createLandingPage.mockImplementation(async (data: Record<string, unknown>) => page({ ...data, id: 'lp_new' }));
  repository.updateLandingPage.mockImplementation(async (_id: string, patch: Record<string, unknown>) => page(patch));
  complete.mockResolvedValue({ text: MODEL_ANSWER, provider: 'anthropic', model: 'claude-sonnet-5' });
  createNotification.mockResolvedValue(undefined);
  ai.assertLandingPageQuota.mockResolvedValue({ used: 1, quota: 3, paid: false });
  ai.recordLandingPageGeneration.mockResolvedValue(undefined);
});

describe('drafting from the brief', () => {
  it('asks the model with the brief and lays out the five blocks', async () => {
    const created = await generateLandingPage('cmp_1', advertiser);

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('Brand: Kumar Sweets') })
    );
    const data = repository.createLandingPage.mock.calls[0]![0];
    expect(data.slug).toMatch(/^diwali-sale-2026-[a-z0-9]{4}$/);
    expect(data.generatedByAi).toBe(true);
    expect(data.createdByUserId).toBe('usr_adv');
    expect((data.blocks as { type: string }[]).map((block) => block.type)).toEqual(['hero', 'offer', 'cta', 'contact', 'gallery']);
    expect(data.blocks[0]).toMatchObject({ type: 'hero', headline: 'Sweeten this Diwali' });
    expect(created.id).toBe('lp_new');

    expect(logActivity).toHaveBeenCalledWith(
      'usr_adv',
      'LANDING_PAGE_GENERATED',
      expect.objectContaining({
        targetType: 'LandingPage',
        targetId: 'lp_new',
        metadata: expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-5' }),
      })
    );
  });

  it('points the CTA at the campaign own destination when it has one', async () => {
    repository.findCampaign.mockResolvedValue(campaign({ trackingConfig: { destinationUrl: 'https://kumarsweets.in/diwali' } }));
    await generateLandingPage('cmp_1', advertiser);
    const data = repository.createLandingPage.mock.calls[0]![0];
    expect(data.blocks[2]).toEqual({ type: 'cta', label: 'Order a box', href: 'https://kumarsweets.in/diwali' });
  });

  it('redrafts a draft as the next version, and refuses to redraft a live page', async () => {
    repository.findLandingPage.mockResolvedValue(page({ version: 2 }));
    await generateLandingPage('cmp_1', advertiser);
    expect(repository.updateLandingPage).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ version: 3, generatedByAi: true }));

    repository.findLandingPage.mockResolvedValue(page({ status: 'PUBLISHED' }));
    await expect(generateLandingPage('cmp_1', advertiser)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('E7-2: spends a draft on the advertiser quota — asked before the model, recorded after it answers, never on a failure', async () => {
    await generateLandingPage('cmp_1', advertiser);
    expect(ai.assertLandingPageQuota).toHaveBeenCalledWith('adv_1', 'cmp_1');
    expect(ai.recordLandingPageGeneration).toHaveBeenCalledWith({ advertiserId: 'adv_1', campaignId: 'cmp_1', provider: 'anthropic', model: 'claude-sonnet-5', output: MODEL_ANSWER });
    expect(logActivity).toHaveBeenCalledWith('usr_adv', 'LANDING_PAGE_GENERATED', expect.objectContaining({ metadata: expect.objectContaining({ quota: { used: 2, quota: 3, paid: false } }) }));

    vi.clearAllMocks();
    ai.assertLandingPageQuota.mockRejectedValue(Object.assign(new Error('spent'), { statusCode: 429, code: 'QUOTA_EXHAUSTED' }));
    await expect(generateLandingPage('cmp_1', advertiser)).rejects.toMatchObject({ statusCode: 429, code: 'QUOTA_EXHAUSTED' });
    expect(complete).not.toHaveBeenCalled();

    ai.assertLandingPageQuota.mockResolvedValue({ used: 0, quota: 3, paid: false });
    complete.mockResolvedValue({ text: 'not a page', provider: 'openai', model: 'x' });
    await expect(generateLandingPage('cmp_1', advertiser)).rejects.toMatchObject({ statusCode: 502 });
    expect(ai.recordLandingPageGeneration).not.toHaveBeenCalled();
  });

  it('is somebody else campaign to a stranger', async () => {
    await expect(generateLandingPage('cmp_1', stranger)).rejects.toMatchObject({ statusCode: 403 });
    expect(complete).not.toHaveBeenCalled();
  });

  it('tells an operator problem from a vendor one', async () => {
    complete.mockRejectedValue(new AiUnavailableError('AI features are turned off for this deployment.'));
    await expect(generateLandingPage('cmp_1', advertiser)).rejects.toMatchObject({ statusCode: 503, code: 'AI_UNAVAILABLE' });

    complete.mockResolvedValue({ text: 'Sure! Here is a page for you.', provider: 'openai', model: 'x' });
    await expect(generateLandingPage('cmp_1', advertiser)).rejects.toMatchObject({ statusCode: 502, code: 'AI_FAILED' });
    expect(repository.createLandingPage).not.toHaveBeenCalled();
  });

  it('reads the JSON out of whatever the model wrapped it in', () => {
    expect(extractJson('```json\n{"hero":{"headline":"Hi"}}\n```')?.['hero']).toEqual({ headline: 'Hi' });
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('[1,2]')).toBeNull();
  });

  it('falls back to the brand when the model leaves a field empty, and never exceeds a block limit', () => {
    const blocks = blocksFrom({ hero: {}, offer: { body: 'x'.repeat(2000) } }, campaign() as never, null);
    expect(blocks[0]).toMatchObject({ type: 'hero', headline: 'Kumar Sweets' });
    expect((blocks[1] as { body: string }).body).toHaveLength(800);
  });

  it('makes a slug out of a name a person typed', () => {
    expect(slugBase('  Diwali Sale — 2026!  ')).toBe('diwali-sale-2026');
    expect(slugBase('???')).toBe('campaign');
  });
});

describe('editing and publishing', () => {
  beforeEach(() => {
    repository.findLandingPage.mockResolvedValue(page());
  });

  it('validates the blocks as a closed vocabulary', () => {
    expect(landingPagePatchSchema.safeParse({ blocks: [{ type: 'hero', headline: 'Hi' }] }).success).toBe(true);
    expect(landingPagePatchSchema.safeParse({ blocks: [{ type: 'script', src: 'x' }] }).success).toBe(false);
    expect(landingPagePatchSchema.safeParse({ blocks: [{ type: 'cta', label: 'Go', href: 'javascript:alert(1)' }] }).success).toBe(false);
    expect(landingPagePatchSchema.safeParse({}).success).toBe(false);
  });

  it('an edit is the next version, live page or not', async () => {
    await patchLandingPage('cmp_1', advertiser, { blocks: [{ type: 'hero', headline: 'New' }] });
    expect(repository.updateLandingPage).toHaveBeenCalledWith('cmp_1', expect.objectContaining({ version: 2 }));
    expect(logActivity).toHaveBeenCalledWith('usr_adv', 'LANDING_PAGE_UPDATED', expect.objectContaining({ targetId: 'lp_1' }));
  });

  it('publishes a page with a hero and stamps when', async () => {
    const published = await publishLandingPage('cmp_1', advertiser);
    expect(repository.updateLandingPage).toHaveBeenCalledWith('cmp_1', { status: 'PUBLISHED', publishedAt: expect.any(Date) });
    expect(published.status).toBe('PUBLISHED');
    expect(logActivity).toHaveBeenCalledWith('usr_adv', 'LANDING_PAGE_PUBLISHED', expect.anything());
  });

  it('will not publish a page with nothing to say', async () => {
    repository.findLandingPage.mockResolvedValue(page({ blocks: [{ type: 'gallery', images: [], placeholders: 3 }] }));
    await expect(publishLandingPage('cmp_1', advertiser)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('ADX takes a live page down with a reason, and the owner hears why', async () => {
    repository.findLandingPage.mockResolvedValue(page({ status: 'PUBLISHED', publishedAt: new Date() }));
    repository.findLandingPageView.mockResolvedValue({ ...page({ status: 'DRAFT', publishedAt: null }), campaign: null });
    await unpublishLandingPage('cmp_1', 'usr_admin', 'Claims a discount the brief never mentioned.');
    expect(repository.updateLandingPage).toHaveBeenCalledWith('cmp_1', { status: 'DRAFT', publishedAt: null });
    expect(logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'LANDING_PAGE_UNPUBLISHED',
      expect.objectContaining({ targetType: 'LandingPage', targetId: 'lp_1', metadata: expect.objectContaining({ reason: expect.stringContaining('discount') }) })
    );
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_adv', type: 'SYSTEM' }));
  });
});

describe('the rendered page', () => {
  const html = renderLandingPage(
    page({
      blocks: [
        { type: 'hero', headline: 'Sweeten <this> Diwali', subheadline: 'Gift boxes' },
        { type: 'offer', title: 'Boxes', body: 'Hand-made & boxed' },
        { type: 'cta', label: 'Order a box', href: null },
        { type: 'contact', phone: '+91 98450 12345', formEnabled: true },
        { type: 'gallery', images: [{ url: 'https://cdn.example/1.jpg', alt: 'A box' }], placeholders: 2 },
      ],
      theme: { accentColor: '#c2410c' },
    }),
    'Diwali Sale 2026'
  );

  it('escapes every string the advertiser wrote', () => {
    expect(html).toContain('Sweeten &lt;this&gt; Diwali');
    expect(html).toContain('Hand-made &amp; boxed');
    expect(html).not.toContain('<this>');
  });

  it('fetches nothing from anywhere but the gallery images the advertiser chose', () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link\s/);
    expect(html).not.toMatch(/@import|url\(/);
    expect(html).toContain('<img src="https://cdn.example/1.jpg" alt="A box"');
  });

  it('carries the beacon for VIEW, CTA_CLICK and FORM_SUBMIT to the code the scan appended', () => {
    expect(html).toContain("get('c')");
    expect(html).toContain("'/t/'+c+'/e'");
    expect(html).toContain("send('VIEW')");
    expect(html).toContain("send('CTA_CLICK'");
    expect(html).toContain("send('FORM_SUBMIT')");
    expect(html).toContain('data-cta="Order a box"');
    expect(html).toContain('id="lead-form"');
  });

  it('uses the theme colour and asks no age', () => {
    expect(html).toContain('#c2410c');
    expect(html.toLowerCase()).not.toMatch(/\bage\b|date of birth|18\+/);
  });

  it('draws the empty gallery frames as frames, and the tel link on the phone', () => {
    expect(html.match(/class="placeholder"/g)).toHaveLength(2);
    expect(html).toContain('href="tel:+919845012345"');
  });

  it('drops a block it cannot read rather than rendering it raw', () => {
    const odd = renderLandingPage({ blocks: [{ type: 'hero', headline: 'Ok' }, { type: 'iframe', src: 'x' }], theme: null }, 't');
    expect(odd).toContain('Ok');
    expect(odd).not.toContain('iframe');
  });
});

describe('the scan, with a page to land on', () => {
  const phone = { userAgent: 'Mozilla/5.0 (iPhone)', referer: null, city: 'Bengaluru' };

  beforeEach(() => {
    repository.findTrackingCode.mockResolvedValue({ id: 'code_1', code: 'AB23CD45', destination: null, campaign: { id: 'cmp_1', status: 'LIVE' } });
    repository.recordTrackingEvent.mockResolvedValue(undefined);
    repository.bumpTrackingCounter.mockResolvedValue(undefined);
  });

  it('sends a code with no destination to the PUBLISHED page, counting the scan and not a click', async () => {
    repository.findLandingPage.mockResolvedValue(page({ status: 'PUBLISHED' }));
    const result = await resolveScan('AB23CD45', phone);
    expect(result).toEqual({ destination: null, landingSlug: 'diwali-sale-2026-k7m2', counted: true });
    expect(repository.bumpTrackingCounter).toHaveBeenCalledWith('code_1', 'scans', 1);
    expect(repository.bumpTrackingCounter).not.toHaveBeenCalledWith('code_1', 'clicks', 1);
  });

  it('has no page to offer while the page is a draft', async () => {
    repository.findLandingPage.mockResolvedValue(page({ status: 'DRAFT' }));
    expect((await resolveScan('AB23CD45', phone)).landingSlug).toBeNull();
  });

  it('never overrides a destination the advertiser gave', async () => {
    repository.findTrackingCode.mockResolvedValue({ id: 'code_1', code: 'AB23CD45', destination: 'https://kumarsweets.in/?utm_source=adx', campaign: { id: 'cmp_1', status: 'LIVE' } });
    repository.findLandingPage.mockResolvedValue(page({ status: 'PUBLISHED' }));
    const result = await resolveScan('AB23CD45', phone);
    expect(result.destination).toBe('https://kumarsweets.in/?utm_source=adx');
    expect(result.landingSlug).toBeNull();
    expect(repository.findLandingPage).not.toHaveBeenCalled();
  });
});
