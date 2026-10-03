/**
 * PB-1 (27 Sep 2026): the rules an address is held to. Pure — no I/O — so
 * every rule is one line in a test. The owner: "assign proper URLs to the
 * new pages and edit existing URLs as well."
 *
 * An address is `/segment/segment`: lowercase letters, digits and single
 * hyphens per segment, at most five segments and 120 characters, no trailing
 * slash, no dot (so a file name is never a page), and a first segment that
 * is not one the website or the API already owns. A `:param` segment is
 * allowed only where a SYSTEM page's own route has one, in the same place —
 * `/spaces/:id` may become `/ad-spaces/:id`, never `/ad-spaces` — and only
 * the home page lives at `/`. Uniqueness across pages and redirect sources
 * is the service's check, since it needs the database.
 */

export const PAGE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_KEY_LENGTH = 64;

/** The one page whose address is `/`. */
export const HOME_KEY = 'home';

export const MAX_SEGMENTS = 5;
export const MAX_PATH_LENGTH = 120;
export const MAX_TARGET_LENGTH = 500;

export const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PARAM = /^:[a-z][a-zA-Z0-9]*$/;

/**
 * First segments a page may not take: the API and Next's own, the studio
 * and preview doors, the sign-in and verification flows, the party areas,
 * the cart, the short links (`/q`, `/j`, `/s`, `/t`), the status page, the
 * legal documents, the account and admin areas, the static folders, and the
 * hand-written pages the site keeps.
 */
export const RESERVED_FIRST_SEGMENTS = [
  'api',
  '_next',
  'studio',
  'pg',
  'preview',
  'sign',
  'verify',
  'verify-2fa',
  'verify-phone',
  'verify-email',
  'advertiser',
  'publisher',
  'partner',
  'cart',
  'q',
  'j',
  's',
  't',
  'status',
  'legal',
  'legal-documents',
  'account',
  'admin',
  'public',
  'design',
  'brand',
  'icons',
  'contact',
  'privacy',
  'terms',
  'refund',
  'sitemap.xml',
  'robots.txt',
] as const;

export type PathCheck = { ok: true; path: string } | { ok: false; message: string };

/** What the address is for: which page, of which kind, drawn by which route (a SYSTEM page's `internalPath`). */
export type PathScope = { key: string; kind: 'SYSTEM' | 'CUSTOM'; internalPath?: string | null | undefined };

const no = (message: string): PathCheck => ({ ok: false, message });
const ok = (path: string): PathCheck => ({ ok: true, path });

/** The segments of a path — none for `/`. */
export const segmentsOf = (path: string): string[] => (path === '/' ? [] : path.replace(/^\//, '').split('/'));

/** Where a path's `:param` segments sit. */
export const paramPositions = (path: string): number[] => segmentsOf(path).flatMap((segment, index) => (segment.startsWith(':') ? [index] : []));

export const hasParam = (path: string): boolean => paramPositions(path).length > 0;

/** Every way an address is wrong for this page, or the address itself, trimmed. */
export function checkSitePath(raw: unknown, scope: PathScope): PathCheck {
  if (typeof raw !== 'string') return no('An address is text — "/diwali-offers"');
  const path = raw.trim();
  if (!path.startsWith('/')) return no('An address starts with "/" — "/diwali-offers"');
  if (path === '/') return scope.kind === 'SYSTEM' && scope.key === HOME_KEY ? ok(path) : no('Only the home page lives at "/"');
  if (path.length > MAX_PATH_LENGTH) return no(`An address is at most ${MAX_PATH_LENGTH} characters`);
  if (path.endsWith('/')) return no('An address has no trailing slash');
  if (/[\s?#]/.test(path)) return no('An address has no spaces, "?" or "#"');
  if (path.includes('.')) return no('An address has no "." — a dot would read as a file');
  const segments = segmentsOf(path);
  if (segments.length > MAX_SEGMENTS) return no(`An address has at most ${MAX_SEGMENTS} segments`);
  const internal = scope.kind === 'SYSTEM' && scope.internalPath ? segmentsOf(scope.internalPath) : [];
  for (const [index, segment] of segments.entries()) {
    if (segment === '') return no('An address has no empty segment ("//")');
    if (segment.startsWith(':')) {
      if (!PARAM.test(segment)) return no(`"${segment}" is not a parameter — ":id"`);
      if (!internal[index]?.startsWith(':')) {
        return no(
          scope.kind === 'SYSTEM' && scope.internalPath
            ? `A ":param" goes only where this page's route has one — ${scope.internalPath}`
            : 'A custom page has no ":param" segment',
        );
      }
      continue;
    }
    if (!SEGMENT.test(segment)) return no(`"${segment}" — a segment is lowercase letters, digits and single hyphens`);
  }
  if ((RESERVED_FIRST_SEGMENTS as readonly string[]).includes(segments[0]!)) return no(`"/${segments[0]}" is reserved — the site or the API lives there`);
  if (scope.kind === 'SYSTEM' && scope.internalPath) {
    const want = paramPositions(scope.internalPath).length;
    if (paramPositions(path).length !== want) {
      return no(
        want === 0
          ? `${scope.internalPath} has no parameter — the address takes none`
          : `This page's route is ${scope.internalPath} — the address keeps its ${want === 1 ? 'parameter' : 'parameters'}`,
      );
    }
  }
  return ok(path);
}

/** A redirect's source: the same rules as a custom page's address — no `:param`, never `/`. */
export const checkRedirectSource = (raw: unknown): PathCheck => checkSitePath(raw, { key: '', kind: 'CUSTOM' });

/** Where a redirect sends the visitor: a path on this site (a query allowed), or an https URL elsewhere. */
export function checkRedirectTarget(raw: unknown): PathCheck {
  if (typeof raw !== 'string') return no('A destination is text — "/spaces" or "https://…"');
  const target = raw.trim();
  if (!target) return no('A destination is a path on this site or an https URL');
  if (target.length > MAX_TARGET_LENGTH) return no(`A destination is at most ${MAX_TARGET_LENGTH} characters`);
  if (/\s/.test(target)) return no('A destination has no spaces');
  if (target.startsWith('/')) {
    if (target.startsWith('//')) return no('A destination on this site starts with one "/"');
    if (hasParam(target.split('?')[0]!)) return no('A destination has no ":param" — a redirect\'s source cannot carry one');
    return ok(target);
  }
  if (!/^https:\/\//i.test(target)) return no('A destination elsewhere starts with https://');
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || !url.hostname) return no('A destination elsewhere is a full https URL');
  } catch {
    return no('A destination elsewhere is a full https URL');
  }
  return ok(target);
}

/** A page key: lowercase letters, digits and single hyphens, at most 64 characters. */
export function checkPageKey(raw: unknown): PathCheck {
  if (typeof raw !== 'string') return no('A key is text — "diwali-2026"');
  const key = raw.trim();
  if (!key || key.length > MAX_KEY_LENGTH || !PAGE_KEY.test(key)) {
    return no(`A key is lowercase letters, digits and single hyphens, at most ${MAX_KEY_LENGTH} characters — "diwali-2026"`);
  }
  return ok(key);
}
