import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LD-1 (3 Oct 2026): spot-page views.
 *
 * Pinned:
 *  - only a live spot is counted (404 otherwise, by id or by `LST-…`);
 *  - never counted: obvious bots, ADX staff, the spot's own publisher, the
 *    agent who keyed it in and the agent who manages the publisher;
 *  - the visitor is stored as a keyed hash of the day, the spot and the
 *    user (or address and browser) — never the address, the browser or
 *    the id, and a different key on another day or another spot;
 *  - the count is written for the Indian day, from the source the client
 *    named, with the one-minute repeat window;
 *  - the repository's statement binds every value, splices none.
 */

const views = vi.hoisted(() => ({ findLiveForView: vi.fn(), record: vi.fn() }));
vi.mock('../prisma-listing-views.repository', () => ({ prismaListingViewsRepository: views }));

import { VIEW_REPEAT_WINDOW_MS, isLikelyBot, recordListingView, visitorKey } from '../listing-views.service';

const BROWSER = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';
const LIVE = { id: 'lst_1', publisherUserId: 'usr_pub', publisherAgentUserId: 'usr_mgr', agentUserId: 'usr_keyer' };
// 3 Oct 2026, 20:00 in India. The boundary case below is 00:30 on the 4th in India — still the 3rd in UTC.
const now = new Date('2026-10-03T14:30:00Z');
const visitor = { idOrDisplayId: 'LST-0310-2601', source: 'WEB' as const, user: null, ip: '203.0.113.7', userAgent: BROWSER };

beforeEach(() => {
  vi.clearAllMocks();
  views.findLiveForView.mockResolvedValue(LIVE);
  views.record.mockResolvedValue({ counted: true, uniqueVisitor: true });
});

describe('POST /listings/:displayIdOrId/view', () => {
  it('counts a visitor on a live spot, for the Indian day, from the source named', async () => {
    expect(await recordListingView(visitor, now)).toEqual({ counted: true });
    expect(views.findLiveForView).toHaveBeenCalledWith('LST-0310-2601');
    expect(views.record).toHaveBeenCalledWith({
      listingId: 'lst_1',
      day: '2026-10-03',
      visitorHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      source: 'WEB',
      now,
      repeatWithinMs: VIEW_REPEAT_WINDOW_MS,
    });
  });

  it('dates a view just after midnight in India by India’s day', async () => {
    await recordListingView(visitor, new Date('2026-10-03T19:00:00Z'));
    expect(views.record.mock.calls[0]![0].day).toBe('2026-10-04');
  });

  it('says a repeat inside the window was not counted', async () => {
    views.record.mockResolvedValue({ counted: false, uniqueVisitor: false });
    expect(await recordListingView(visitor, now)).toEqual({ counted: false });
  });

  it('404s a spot that is not live, and an id past any real length', async () => {
    views.findLiveForView.mockResolvedValue(null);
    await expect(recordListingView(visitor, now)).rejects.toMatchObject({ statusCode: 404 });
    await expect(recordListingView({ ...visitor, idOrDisplayId: 'x'.repeat(65) }, now)).rejects.toMatchObject({ statusCode: 404 });
    expect(views.record).not.toHaveBeenCalled();
  });

  it.each([
    ['no browser at all', null],
    ['a crawler', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['a link preview', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
    ['a script', 'curl/8.4.0'],
    ['a headless browser', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0 Safari/537.36'],
  ])('does not count %s', async (_label, userAgent) => {
    expect(await recordListingView({ ...visitor, userAgent }, now)).toEqual({ counted: false });
    expect(views.record).not.toHaveBeenCalled();
  });

  it('counts the app, whose requests carry the phone’s HTTP client', () => {
    expect(isLikelyBot('okhttp/4.12.0')).toBe(false);
    expect(isLikelyBot('ADX/1.0 CFNetwork/1494.0.7 Darwin/23.4.0')).toBe(false);
    expect(isLikelyBot(BROWSER)).toBe(false);
  });

  it.each([
    ['ADX staff', { id: 'usr_ops', roles: ['ADMIN'] }],
    ['the spot’s publisher', { id: 'usr_pub', roles: ['PUBLISHER'] }],
    ['the agent who keyed it in', { id: 'usr_keyer', roles: ['AGENT_PUBLISHER'] }],
    ['the agent who manages the publisher', { id: 'usr_mgr', roles: ['AGENT_PUBLISHER'] }],
  ])('never counts %s', async (_label, user) => {
    expect(await recordListingView({ ...visitor, user, source: 'APP' }, now)).toEqual({ counted: false });
    expect(views.record).not.toHaveBeenCalled();
  });

  it('counts a signed-in advertiser, keyed by who they are rather than where they are', async () => {
    const user = { id: 'usr_adv', roles: ['ADVERTISER'] };
    await recordListingView({ ...visitor, user, source: 'APP', ip: '198.51.100.1' }, now);
    await recordListingView({ ...visitor, user, source: 'APP', ip: '198.51.100.99', userAgent: 'okhttp/4.12.0' }, now);
    const [first, second] = views.record.mock.calls.map((call) => call[0].visitorHash as string);
    expect(first).toBe(second);
  });
});

describe('the statement that counts', () => {
  it('binds every value and splices none into the text', async () => {
    vi.resetModules();
    vi.doUnmock('../prisma-listing-views.repository');
    const queryRaw = vi.fn(async () => [{ counted: true, unique_visitor: true }]);
    vi.doMock('../../../shared/database', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../shared/database')>()),
      prisma: { $queryRaw: queryRaw, listing: { findFirst: vi.fn() } },
    }));
    const { prismaListingViewsRepository } = await import('../prisma-listing-views.repository');
    const result = await prismaListingViewsRepository.record({
      listingId: "lst_1'; DROP TABLE \"Listing\"; --",
      day: '2026-10-03',
      visitorHash: 'hash_abc',
      source: 'APP',
      now,
      repeatWithinMs: 60_000,
    });
    expect(result).toEqual({ counted: true, uniqueVisitor: true });
    const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).not.toContain('DROP TABLE');
    expect(strings.join('?')).not.toContain('hash_abc');
    expect(values).toContain("lst_1'; DROP TABLE \"Listing\"; --");
    expect(values).toContain('hash_abc');
    expect(values).toContain(0); // web
    expect(values).toContain(1); // app
    expect(values).toContainEqual(new Date(now.getTime() - 60_000));
    vi.doUnmock('../../../shared/database');
  });
});

describe('the visitor key', () => {
  const who = { userId: null, ip: '203.0.113.7', userAgent: BROWSER };

  it('never carries the address, the browser or the user id', () => {
    const key = visitorKey('lst_1', '2026-10-03', who);
    expect(key).not.toContain('203.0.113.7');
    expect(key).not.toContain('Mozilla');
    expect(visitorKey('lst_1', '2026-10-03', { userId: 'usr_adv', ip: null, userAgent: null })).not.toContain('usr_adv');
  });

  it('is the same for one visitor on one spot on one day, and different on another day or another spot', () => {
    const key = visitorKey('lst_1', '2026-10-03', who);
    expect(visitorKey('lst_1', '2026-10-03', { ...who })).toBe(key);
    expect(visitorKey('lst_1', '2026-10-04', who)).not.toBe(key);
    expect(visitorKey('lst_2', '2026-10-03', who)).not.toBe(key);
    expect(visitorKey('lst_1', '2026-10-03', { ...who, userAgent: 'Mozilla/5.0 (iPhone)' })).not.toBe(key);
  });
});
