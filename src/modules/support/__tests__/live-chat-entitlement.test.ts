import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot I — who gets live chat.
 *
 * What is pinned: a publisher on a running subscription and an advertiser on
 * an ACTIVE package are entitled; a plan whose entitlements JSON sets
 * `liveChat: false` is not, and says PLAN_EXCLUDED rather than
 * NOT_SUBSCRIBED; `support.liveChat.publisherTiers` narrows the publisher
 * side and an empty list means every tier; a login with neither record is
 * NOT_A_SUBSCRIBER_ROLE; a login holding both is entitled if either side
 * pays; ops' own switch (`support.liveChat.enabled`) answers FEATURE_OFF.
 */

const { publishers, advertisers, revenue, packages, settings } = vi.hoisted(() => ({
  publishers: { findPublisherForUser: vi.fn(), findPublisherLabelsForUsers: vi.fn() },
  advertisers: { getAdvertiserForUser: vi.fn(), findAdvertiserLabelsForUsers: vi.fn() },
  // Lot J2 (4): the grace-aware reads — running, or ended within the policy's graceDays.
  revenue: { entitledSubscriptionForPublisher: vi.fn(), entitledSubscriptionsForPublishers: vi.fn(), publisherPlansByTier: vi.fn() },
  packages: { entitledPackageForAdvertiser: vi.fn(), entitledPackagesForAdvertisers: vi.fn() },
  settings: { getPlatformSettings: vi.fn() },
}));

vi.mock('../../publishers', () => publishers);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../revenue', () => revenue);
vi.mock('../../packages', () => packages);
vi.mock('../../app-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app-config')>()),
  ...settings,
}));

import { liveChatEntitlement, liveChatEntitlementsFor, planAllowsLiveChat, planOnDesk, tierAllowed } from '../live-chat.entitlement';
import { DEFAULT_PLATFORM_SETTINGS } from '../../app-config';

const withLiveChat = (over: Partial<(typeof DEFAULT_PLATFORM_SETTINGS)['support']['liveChat']> = {}) => ({
  ...DEFAULT_PLATFORM_SETTINGS,
  support: { ...DEFAULT_PLATFORM_SETTINGS.support, liveChat: { ...DEFAULT_PLATFORM_SETTINGS.support.liveChat, ...over } },
});

beforeEach(() => {
  vi.clearAllMocks();
  settings.getPlatformSettings.mockResolvedValue(withLiveChat());
  publishers.findPublisherForUser.mockResolvedValue(null);
  advertisers.getAdvertiserForUser.mockResolvedValue(null);
  revenue.entitledSubscriptionForPublisher.mockResolvedValue(null);
  packages.entitledPackageForAdvertiser.mockResolvedValue(null);
  publishers.findPublisherLabelsForUsers.mockResolvedValue([]);
  advertisers.findAdvertiserLabelsForUsers.mockResolvedValue([]);
  revenue.entitledSubscriptionsForPublishers.mockResolvedValue(new Map());
  packages.entitledPackagesForAdvertisers.mockResolvedValue(new Map());
  // Lot J-B1: the default catalogue — Standard says no, Plus and Pro say yes.
  revenue.publisherPlansByTier.mockResolvedValue(
    new Map([
      ['STANDARD', { tier: 'STANDARD', name: 'Standard', entitlements: { liveChat: false }, isActive: true }],
      ['PLUS', { tier: 'PLUS', name: 'Plus', entitlements: { liveChat: true }, isActive: true }],
      ['PRO', { tier: 'PRO', name: 'Pro', entitlements: { liveChat: true }, isActive: true }],
    ]),
  );
});

describe('the two pure rules', () => {
  it('a plan excludes live chat only by saying so', () => {
    expect(planAllowsLiveChat(undefined)).toBe(true);
    expect(planAllowsLiveChat({})).toBe(true);
    expect(planAllowsLiveChat({ support: 'STANDARD' })).toBe(true);
    expect(planAllowsLiveChat({ liveChat: true })).toBe(true);
    expect(planAllowsLiveChat({ liveChat: false })).toBe(false);
  });

  it('an empty tier list is every tier', () => {
    expect(tierAllowed('STANDARD', [])).toBe(true);
    expect(tierAllowed('STANDARD', ['PLUS', 'PRO'])).toBe(false);
    expect(tierAllowed('plus', ['PLUS'])).toBe(true);
  });
});

describe('a publisher', () => {
  beforeEach(() => publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1' }));

  it('on a running subscription is entitled, and the plan names the tier', async () => {
    revenue.entitledSubscriptionForPublisher.mockResolvedValue({ id: 'sub_1', tier: 'PLUS', startsAt: new Date(), endsAt: null });
    const answer = await liveChatEntitlement('usr_pub');
    expect(answer).toMatchObject({ entitled: true, reason: 'PUBLISHER_SUBSCRIPTION', plan: { tier: 'PLUS' } });
    expect(answer.upsell.href).toBe('/publisher/subscription');
  });

  it('with no running subscription is NOT_SUBSCRIBED, pointed at the subscription screen', async () => {
    const answer = await liveChatEntitlement('usr_pub');
    expect(answer).toMatchObject({ entitled: false, reason: 'NOT_SUBSCRIBED', plan: null });
    expect(answer.upsell.href).toBe('/publisher/subscription');
  });

  it('on a tier the settings leave out is PLAN_EXCLUDED, not NOT_SUBSCRIBED — they are paying', async () => {
    settings.getPlatformSettings.mockResolvedValue(withLiveChat({ publisherTiers: ['PRO'] }));
    revenue.entitledSubscriptionForPublisher.mockResolvedValue({ id: 'sub_1', tier: 'STANDARD', startsAt: new Date(), endsAt: null });
    expect(await liveChatEntitlement('usr_pub')).toMatchObject({ entitled: false, reason: 'PLAN_EXCLUDED', plan: { tier: 'STANDARD' } });
  });

  /**
   * Lot J-B1: the tier's plan is read from revenue's catalogue. The default
   * Standard plan says `liveChat: false`, so a Standard subscriber is
   * PLAN_EXCLUDED even with the settings wide open; the plan editor is
   * where that changes, and the answer names the catalogue plan.
   */
  it('on a plan whose entitlements set liveChat false is PLAN_EXCLUDED, named after the plan', async () => {
    revenue.entitledSubscriptionForPublisher.mockResolvedValue({ id: 'sub_1', tier: 'STANDARD', startsAt: new Date(), endsAt: null });
    const answer = await liveChatEntitlement('usr_pub');
    expect(answer).toMatchObject({ entitled: false, reason: 'PLAN_EXCLUDED', plan: { name: 'Standard plan', tier: 'STANDARD' } });
    expect(revenue.publisherPlansByTier).toHaveBeenCalledTimes(1);
  });

  it('is entitled once the plan editor switches the tier on, and names the plan', async () => {
    revenue.publisherPlansByTier.mockResolvedValue(new Map([['STANDARD', { tier: 'STANDARD', name: 'Standard', entitlements: { liveChat: true }, isActive: true }]]));
    revenue.entitledSubscriptionForPublisher.mockResolvedValue({ id: 'sub_1', tier: 'STANDARD', startsAt: new Date(), endsAt: null });
    expect(await liveChatEntitlement('usr_pub')).toMatchObject({ entitled: true, reason: 'PUBLISHER_SUBSCRIPTION', plan: { name: 'Standard plan', tier: 'STANDARD' } });
  });

  it('a tier with no catalogue row is judged by the settings alone, and named after the tier', async () => {
    revenue.publisherPlansByTier.mockResolvedValue(new Map());
    revenue.entitledSubscriptionForPublisher.mockResolvedValue({ id: 'sub_1', tier: 'PLUS', startsAt: new Date(), endsAt: null });
    expect(await liveChatEntitlement('usr_pub')).toMatchObject({ entitled: true, plan: { name: 'Plus subscription', tier: 'PLUS' } });
  });

  it('does not read the catalogue when there is nothing running', async () => {
    await liveChatEntitlement('usr_pub');
    expect(revenue.publisherPlansByTier).not.toHaveBeenCalled();
  });
});

describe('an advertiser', () => {
  beforeEach(() => advertisers.getAdvertiserForUser.mockResolvedValue({ id: 'adv_1' }));

  it('on an ACTIVE package whose plan says nothing about live chat is entitled', async () => {
    packages.entitledPackageForAdvertiser.mockResolvedValue({ tier: 'GROWTH', packageName: 'Growth', entitlements: { campaignsPerMonth: 8 } });
    const answer = await liveChatEntitlement('usr_adv');
    expect(answer).toMatchObject({ entitled: true, reason: 'ADVERTISER_PACKAGE', plan: { name: 'Growth', tier: 'GROWTH' } });
    expect(answer.upsell.href).toBe('/advertiser/packages');
  });

  it('on a plan whose entitlements set liveChat false is PLAN_EXCLUDED', async () => {
    packages.entitledPackageForAdvertiser.mockResolvedValue({ tier: 'STARTER', packageName: 'Starter', entitlements: { liveChat: false } });
    expect(await liveChatEntitlement('usr_adv')).toMatchObject({ entitled: false, reason: 'PLAN_EXCLUDED', plan: { name: 'Starter' } });
  });

  it('with no package is NOT_SUBSCRIBED', async () => {
    expect(await liveChatEntitlement('usr_adv')).toMatchObject({ entitled: false, reason: 'NOT_SUBSCRIBED' });
  });
});

describe('everybody else', () => {
  it('an agent, a partner, an admin — no party record at all — is NOT_A_SUBSCRIBER_ROLE and keeps the ticket thread', async () => {
    const answer = await liveChatEntitlement('usr_agent');
    expect(answer).toMatchObject({ entitled: false, reason: 'NOT_A_SUBSCRIBER_ROLE', plan: null });
    expect(answer.upsell.href).toBe('/support/tickets');
    expect(revenue.entitledSubscriptionForPublisher).not.toHaveBeenCalled();
    expect(packages.entitledPackageForAdvertiser).not.toHaveBeenCalled();
  });

  it('a login on both sides is entitled when either pays', async () => {
    publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1' });
    advertisers.getAdvertiserForUser.mockResolvedValue({ id: 'adv_1' });
    packages.entitledPackageForAdvertiser.mockResolvedValue({ tier: 'GROWTH', packageName: 'Growth', entitlements: {} });
    expect(await liveChatEntitlement('usr_both')).toMatchObject({ entitled: true, reason: 'ADVERTISER_PACKAGE' });
  });

  it('ops switching live chat off in the settings answers FEATURE_OFF before any party is read', async () => {
    settings.getPlatformSettings.mockResolvedValue(withLiveChat({ enabled: false }));
    publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1' });
    expect(await liveChatEntitlement('usr_pub')).toMatchObject({ entitled: false, reason: 'FEATURE_OFF' });
    expect(publishers.findPublisherForUser).not.toHaveBeenCalled();
  });
});

describe('the batch read (I4-B) — what the desk\'s inbox asks', () => {
  it('answers every login in one query per source and agrees with the single read', async () => {
    publishers.findPublisherLabelsForUsers.mockResolvedValue([
      { id: 'pub_1', userId: 'usr_pub', displayId: null, name: 'Asha', kycStatus: 'VERIFIED' },
      { id: 'pub_2', userId: 'usr_lapsed', displayId: null, name: 'Ravi', kycStatus: 'VERIFIED' },
    ]);
    advertisers.findAdvertiserLabelsForUsers.mockResolvedValue([
      { id: 'adv_1', userId: 'usr_adv', displayId: null, name: 'Brand', kycStatus: 'VERIFIED' },
      { id: 'adv_2', userId: 'usr_starter', displayId: null, name: 'Small', kycStatus: 'VERIFIED' },
    ]);
    revenue.entitledSubscriptionsForPublishers.mockResolvedValue(new Map([['pub_1', { id: 'sub_1', tier: 'PLUS', startsAt: new Date(), endsAt: null }]]));
    packages.entitledPackagesForAdvertisers.mockResolvedValue(
      new Map([
        ['adv_1', { tier: 'GROWTH', packageName: 'Growth', entitlements: {} }],
        ['adv_2', { tier: 'STARTER', packageName: 'Starter', entitlements: { liveChat: false } }],
      ]),
    );

    const answers = await liveChatEntitlementsFor(['usr_pub', 'usr_lapsed', 'usr_adv', 'usr_starter', 'usr_agent', 'usr_pub']);

    // Lot J-B1: the plan carries the catalogue's own name once, for the whole page.
    expect(answers.get('usr_pub')).toMatchObject({ entitled: true, reason: 'PUBLISHER_SUBSCRIPTION', plan: { name: 'Plus plan', tier: 'PLUS' } });
    expect(revenue.publisherPlansByTier).toHaveBeenCalledTimes(1);
    expect(answers.get('usr_lapsed')).toMatchObject({ entitled: false, reason: 'NOT_SUBSCRIBED', plan: null });
    expect(answers.get('usr_lapsed')!.upsell.href).toBe('/publisher/subscription');
    expect(answers.get('usr_adv')).toMatchObject({ entitled: true, reason: 'ADVERTISER_PACKAGE', plan: { name: 'Growth' } });
    expect(answers.get('usr_starter')).toMatchObject({ entitled: false, reason: 'PLAN_EXCLUDED', plan: { name: 'Starter' } });
    expect(answers.get('usr_agent')).toMatchObject({ entitled: false, reason: 'NOT_A_SUBSCRIBER_ROLE', plan: null });

    // One round trip per source, the ids de-duplicated; never the per-login reads.
    expect(publishers.findPublisherLabelsForUsers).toHaveBeenCalledTimes(1);
    expect(publishers.findPublisherLabelsForUsers).toHaveBeenCalledWith(['usr_pub', 'usr_lapsed', 'usr_adv', 'usr_starter', 'usr_agent']);
    expect(advertisers.findAdvertiserLabelsForUsers).toHaveBeenCalledTimes(1);
    expect(revenue.entitledSubscriptionsForPublishers).toHaveBeenCalledTimes(1);
    expect(revenue.entitledSubscriptionsForPublishers).toHaveBeenCalledWith(['pub_1', 'pub_2'], expect.any(Date));
    expect(packages.entitledPackagesForAdvertisers).toHaveBeenCalledTimes(1);
    expect(packages.entitledPackagesForAdvertisers).toHaveBeenCalledWith(['adv_1', 'adv_2'], expect.any(Date));
    expect(publishers.findPublisherForUser).not.toHaveBeenCalled();
    expect(revenue.entitledSubscriptionForPublisher).not.toHaveBeenCalled();
    expect(packages.entitledPackageForAdvertiser).not.toHaveBeenCalled();
  });

  it('narrows the publisher side by tier the same way, and says FEATURE_OFF for everyone when ops switch it off', async () => {
    settings.getPlatformSettings.mockResolvedValue(withLiveChat({ publisherTiers: ['PRO'] }));
    publishers.findPublisherLabelsForUsers.mockResolvedValue([{ id: 'pub_1', userId: 'usr_pub', displayId: null, name: 'Asha', kycStatus: 'VERIFIED' }]);
    revenue.entitledSubscriptionsForPublishers.mockResolvedValue(new Map([['pub_1', { id: 'sub_1', tier: 'STANDARD', startsAt: new Date(), endsAt: null }]]));
    expect((await liveChatEntitlementsFor(['usr_pub'])).get('usr_pub')).toMatchObject({ entitled: false, reason: 'PLAN_EXCLUDED', plan: { tier: 'STANDARD' } });

    settings.getPlatformSettings.mockResolvedValue(withLiveChat({ enabled: false }));
    publishers.findPublisherLabelsForUsers.mockClear();
    expect((await liveChatEntitlementsFor(['usr_pub'])).get('usr_pub')).toMatchObject({ entitled: false, reason: 'FEATURE_OFF' });
    expect(publishers.findPublisherLabelsForUsers).not.toHaveBeenCalled();
  });

  it('asks nothing for an empty page', async () => {
    expect((await liveChatEntitlementsFor([])).size).toBe(0);
    expect(settings.getPlatformSettings).not.toHaveBeenCalled();
  });

  it('planOnDesk is the plan and the reason, or null with nothing paid', () => {
    expect(planOnDesk({ entitled: true, reason: 'ADVERTISER_PACKAGE', plan: { name: 'Growth', tier: 'GROWTH' }, upsell: { title: '', href: '' }, grace: null })).toEqual({
      name: 'Growth',
      reason: 'ADVERTISER_PACKAGE',
      grace: null,
    });
    expect(planOnDesk({ entitled: false, reason: 'NOT_SUBSCRIBED', plan: null, upsell: { title: '', href: '' }, grace: null })).toBeNull();
    expect(planOnDesk(undefined)).toBeNull();
  });
});

/* ── Lot J2 (4): grace ───────────────────────────────────────────── */

describe('a term in grace (Lot J2)', () => {
  const UNTIL = new Date('2026-09-21T06:00:00.000Z');

  it('a publisher whose subscription ended inside the grace window is still entitled, and the answer says until when', async () => {
    publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1' });
    revenue.entitledSubscriptionForPublisher.mockResolvedValue({ id: 'sub_1', tier: 'PLUS', startsAt: new Date('2026-08-14T06:00:00.000Z'), endsAt: new Date('2026-09-18T06:00:00.000Z'), inGrace: true, graceEndsAt: UNTIL });
    const answer = await liveChatEntitlement('usr_pub');
    expect(answer).toMatchObject({ entitled: true, reason: 'PUBLISHER_SUBSCRIPTION', plan: { name: 'Plus plan' }, grace: { until: UNTIL, note: 'in grace until 21 Sept 2026' } });
    expect(planOnDesk(answer)).toEqual({ name: 'Plus plan', reason: 'PUBLISHER_SUBSCRIPTION', grace: 'in grace until 21 Sept 2026' });
  });

  it('a running term carries no grace; a plan that excludes live chat is PLAN_EXCLUDED, grace or not', async () => {
    publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1' });
    revenue.entitledSubscriptionForPublisher.mockResolvedValue({ id: 'sub_1', tier: 'PLUS', startsAt: new Date(), endsAt: null, inGrace: false, graceEndsAt: null });
    expect(await liveChatEntitlement('usr_pub')).toMatchObject({ entitled: true, grace: null });
    expect(planOnDesk(await liveChatEntitlement('usr_pub'))).toEqual({ name: 'Plus plan', reason: 'PUBLISHER_SUBSCRIPTION', grace: null });

    revenue.entitledSubscriptionForPublisher.mockResolvedValue({ id: 'sub_1', tier: 'STANDARD', startsAt: new Date(), endsAt: new Date('2026-09-18T06:00:00.000Z'), inGrace: true, graceEndsAt: UNTIL });
    expect(await liveChatEntitlement('usr_pub')).toMatchObject({ entitled: false, reason: 'PLAN_EXCLUDED', grace: { note: 'in grace until 21 Sept 2026' } });
  });

  it('an advertiser whose package ended inside the grace window is still entitled, in the single and the batch read', async () => {
    advertisers.getAdvertiserForUser.mockResolvedValue({ id: 'adv_1' });
    packages.entitledPackageForAdvertiser.mockResolvedValue({ saleId: 'sale_1', packageName: 'Growth', tier: 'GROWTH', entitlements: {}, inGrace: true, graceEndsAt: UNTIL });
    expect(await liveChatEntitlement('usr_adv')).toMatchObject({ entitled: true, reason: 'ADVERTISER_PACKAGE', grace: { until: UNTIL } });

    advertisers.findAdvertiserLabelsForUsers.mockResolvedValue([{ userId: 'usr_adv', id: 'adv_1' }]);
    packages.entitledPackagesForAdvertisers.mockResolvedValue(new Map([['adv_1', { saleId: 'sale_1', packageName: 'Growth', tier: 'GROWTH', entitlements: {}, inGrace: true, graceEndsAt: UNTIL }]]));
    const map = await liveChatEntitlementsFor(['usr_adv']);
    expect(planOnDesk(map.get('usr_adv'))).toEqual({ name: 'Growth', reason: 'ADVERTISER_PACKAGE', grace: 'in grace until 21 Sept 2026' });
  });
});
