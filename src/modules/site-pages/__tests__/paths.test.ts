import { describe, expect, it } from 'vitest';
import { checkPageKey, checkRedirectSource, checkRedirectTarget, checkSitePath, hasParam, paramPositions, RESERVED_FIRST_SEGMENTS, type PathScope } from '../paths';

/**
 * PB-1 — the address rules, one line each.
 *
 * Pinned: an address starts with "/", is lowercase segments of letters,
 * digits and single hyphens, at most five and 120 characters, no trailing
 * slash, no dot, no query; only the home page lives at "/"; a first segment
 * the site or the API owns is refused; a ":param" goes only where a system
 * page's own route has one, in the same place, and a system page keeps its
 * parameter count; a redirect's source is a custom address (no param) and
 * its destination a site path or an https URL.
 */

const custom = { key: 'diwali', kind: 'CUSTOM' as const };
const listing = { key: 'listing', kind: 'SYSTEM' as const, internalPath: '/spaces/:id' };
const home = { key: 'home', kind: 'SYSTEM' as const, internalPath: '/' };

const refused = (raw: unknown, scope: PathScope = custom) => {
  const check = checkSitePath(raw, scope);
  return check.ok ? null : check.message;
};

describe('a custom page address', () => {
  it('takes a clean path, trimmed', () => {
    expect(checkSitePath(' /diwali-offers ', custom)).toEqual({ ok: true, path: '/diwali-offers' });
    expect(checkSitePath('/events/2026/diwali', custom)).toEqual({ ok: true, path: '/events/2026/diwali' });
  });

  it('refuses each malformed shape with a sentence', () => {
    expect(refused(42)).toMatch(/is text/);
    expect(refused('diwali')).toMatch(/starts with "\/"/);
    expect(refused('/')).toMatch(/Only the home page/);
    expect(refused('/diwali/')).toMatch(/trailing slash/);
    expect(refused('/diwali offers')).toMatch(/no spaces/);
    expect(refused('/diwali?x=1')).toMatch(/no spaces, "\?"/);
    expect(refused('/diwali.html')).toMatch(/no "\."/);
    expect(refused('/a/b/c/d/e/f')).toMatch(/at most 5 segments/);
    expect(refused('/Diwali')).toMatch(/lowercase/);
    expect(refused('/diwali--offers')).toMatch(/single hyphens/);
    expect(refused('/-diwali')).toMatch(/single hyphens/);
    expect(refused('/diwali//offers')).toMatch(/empty segment/);
    expect(refused(`/${'a'.repeat(121)}`)).toMatch(/at most 120/);
    expect(refused('/spaces/:id')).toMatch(/custom page has no ":param"/);
  });

  it('refuses every reserved first segment, and only as the first', () => {
    for (const segment of RESERVED_FIRST_SEGMENTS) {
      const message = refused(`/${segment}`);
      expect(message, segment).toBeTruthy();
    }
    expect(refused('/api/v1')).toMatch(/reserved/);
    expect(checkSitePath('/offers/api', custom).ok).toBe(true);
  });
});

describe("a system page's address", () => {
  it('keeps its parameter in the same place, under a new name', () => {
    expect(checkSitePath('/ad-spaces/:id', listing)).toEqual({ ok: true, path: '/ad-spaces/:id' });
    expect(refused('/ad-spaces', listing)).toMatch(/keeps its parameter/);
    expect(refused('/:id/ad-spaces', listing)).toMatch(/only where this page's route has one/);
    expect(refused('/ad-spaces/:Id', listing)).toMatch(/not a parameter/);
    expect(refused('/ad-spaces/:id/:other', listing)).toMatch(/only where this page's route has one/);
  });

  it('lets only the home page live at "/", and refuses a parameter on a page whose route has none', () => {
    expect(checkSitePath('/', home)).toEqual({ ok: true, path: '/' });
    expect(refused('/', listing)).toMatch(/Only the home page/);
    expect(checkSitePath('/welcome', home).ok).toBe(true);
    expect(refused('/spaces/:id', { key: 'explore', kind: 'SYSTEM', internalPath: '/spaces' })).toMatch(/only where this page's route has one/);
  });
});

describe('a redirect', () => {
  it('comes from a custom-shaped address', () => {
    expect(checkRedirectSource('/old-offers')).toEqual({ ok: true, path: '/old-offers' });
    expect(checkRedirectSource('/')).toMatchObject({ ok: false });
    expect(checkRedirectSource('/spaces/:id')).toMatchObject({ ok: false });
    expect(checkRedirectSource('/studio')).toMatchObject({ ok: false });
  });

  it('goes to a site path (a query allowed) or an https URL, never a parameter or http', () => {
    expect(checkRedirectTarget('/spaces?city=pune')).toEqual({ ok: true, path: '/spaces?city=pune' });
    expect(checkRedirectTarget('https://adx.in/help')).toEqual({ ok: true, path: 'https://adx.in/help' });
    expect(checkRedirectTarget('http://adx.in/help')).toMatchObject({ ok: false, message: expect.stringMatching(/https:\/\//) });
    expect(checkRedirectTarget('//evil.example')).toMatchObject({ ok: false });
    expect(checkRedirectTarget('/spaces/:id')).toMatchObject({ ok: false, message: expect.stringMatching(/":param"/) });
    expect(checkRedirectTarget('spaces')).toMatchObject({ ok: false });
    expect(checkRedirectTarget('https://')).toMatchObject({ ok: false });
    expect(checkRedirectTarget('')).toMatchObject({ ok: false });
  });
});

describe('the helpers', () => {
  it('find parameters and check keys', () => {
    expect(paramPositions('/spaces/:id')).toEqual([1]);
    expect(paramPositions('/')).toEqual([]);
    expect(hasParam('/a/:b/c')).toBe(true);
    expect(hasParam('/a/b')).toBe(false);
    expect(checkPageKey('diwali-2026')).toEqual({ ok: true, path: 'diwali-2026' });
    expect(checkPageKey('Diwali')).toMatchObject({ ok: false });
    expect(checkPageKey('a'.repeat(65))).toMatchObject({ ok: false });
    expect(checkPageKey('')).toMatchObject({ ok: false });
  });
});
