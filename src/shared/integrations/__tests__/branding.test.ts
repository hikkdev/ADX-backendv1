import { describe, expect, it } from 'vitest';
import { BRAND_DEFAULTS, brandVersion, resolveBrand } from '../branding';

/**
 * QR-9 (17 Sep 2026) — the brand, DR 11 by default, the console's where
 * retuned.
 *
 * Pinned: with nothing stored every field is DR 11's, the relative file
 * paths resolved against the API's base URL, and `defaults` names them all;
 * a stored value replaces its field and leaves `defaults`; a colour that is
 * not #RRGGBB, or a blank, falls back rather than breaking the theme; the
 * two older fields (`headerLogoUrl`, `authLogoUrl`) still read as the
 * wordmark and the mark; and the version changes with any field.
 */
describe('resolveBrand', () => {
  it('answers DR 11 when nothing is stored, with the files under the API', () => {
    const brand = resolveBrand(undefined, 'http://api.test/');
    expect(brand.platformName).toBe('ADX');
    expect(brand.primaryColor).toBe('#E40209');
    expect(brand.deepColor).toBe('#BD2020');
    expect(brand.wordmarkUrl).toBe('http://api.test/brand/adx-wordmark-red.svg');
    expect(brand.markInverseUrl).toBe('http://api.test/brand/adx-mark-white.svg');
    expect(brand.iconUrl).toBe('http://api.test/brand/adx-icon-tile.svg');
    // QR-11: the website kit's four fields are defaults too.
    expect(brand.defaults).toEqual([
      ...Object.keys(BRAND_DEFAULTS),
      'website.taglines',
      'website.heroImageUrl',
      'website.ogImageUrl',
      'website.faviconUrl',
      'website.siteTitle',
      'website.siteDescription',
      'apps.appIconUrl',
      'console.consoleTitle',
    ]);
    expect(brand.version).toMatch(/^[0-9a-f]{8}$/);
  });

  it('takes a stored value over the default, and says which fields are still defaults', () => {
    const brand = resolveBrand({ platformName: 'ADX Media', primaryColor: '#123456', wordmarkUrl: 'https://cdn/x/wordmark.svg' }, 'http://api.test');
    expect(brand.platformName).toBe('ADX Media');
    expect(brand.primaryColor).toBe('#123456');
    expect(brand.wordmarkUrl).toBe('https://cdn/x/wordmark.svg');
    expect(brand.deepColor).toBe('#BD2020');
    expect(brand.defaults).not.toContain('platformName');
    expect(brand.defaults).not.toContain('primaryColor');
    expect(brand.defaults).toContain('deepColor');
  });

  it('falls back on a colour that is not #RRGGBB, and on a blank', () => {
    const brand = resolveBrand({ primaryColor: 'red', deepColor: '', tagline: '   ' }, 'http://api.test');
    expect(brand.primaryColor).toBe('#E40209');
    expect(brand.deepColor).toBe('#BD2020');
    expect(brand.tagline).toBe(BRAND_DEFAULTS.tagline);
  });

  it('reads the two older fields as the wordmark and the mark', () => {
    const brand = resolveBrand({ headerLogoUrl: 'https://cdn/old/header.png', authLogoUrl: 'https://cdn/old/auth.png' }, 'http://api.test');
    expect(brand.wordmarkUrl).toBe('https://cdn/old/header.png');
    expect(brand.markUrl).toBe('https://cdn/old/auth.png');
    // A newer field wins over the older one it replaces.
    expect(resolveBrand({ headerLogoUrl: 'https://cdn/old.png', wordmarkUrl: 'https://cdn/new.svg' }, 'x').wordmarkUrl).toBe('https://cdn/new.svg');
  });

  it('the version moves with any field and stays put otherwise', () => {
    const a = resolveBrand(undefined, 'http://api.test');
    const b = resolveBrand(undefined, 'http://api.test');
    const c = resolveBrand({ tagline: 'Own the city.' }, 'http://api.test');
    expect(a.version).toBe(b.version);
    expect(c.version).not.toBe(a.version);
    expect(brandVersion({ a: '1' })).not.toBe(brandVersion({ a: '2' }));
  });
});
