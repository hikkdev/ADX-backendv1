import { logger } from '../../../shared/logging';
import { redis } from '../../../shared/cache';
import { getIntegrationsConfig } from '../../../shared/integrations';
import { prismaTokensRepository } from '../tokens/prisma-tokens.repository';
import type { SessionLocation } from '../tokens/tokens.repository';

/**
 * SL-1 (DR 12) — where a session signed in from.
 *
 * The address is looked up after the session is opened, never on the way
 * in: a sign-in does not wait on a third party. The provider is the
 * integrations row's `geoIp` section — `NONE` (the default: nothing is
 * looked up, the sessions page shows the address alone), `IPAPI`
 * (ip-api.com, no key, non-commercial) or `IPINFO` (ipinfo.io, a token).
 * A private or loopback address is never sent anywhere. Answers are cached
 * a week per address.
 */

export type GeoIpProvider = 'NONE' | 'IPAPI' | 'IPINFO';
export type GeoIpConfig = { provider?: GeoIpProvider | undefined; token?: string | undefined };

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** RFC 1918 / loopback / link-local / unique-local — nothing to look up. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  if (v4 === '127.0.0.1' || v4 === '::1' || v4 === '0.0.0.0') return true;
  if (/^10\./.test(v4) || /^192\.168\./.test(v4) || /^169\.254\./.test(v4)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v4)) return true;
  if (/^(fc|fd|fe80)/i.test(v4)) return true;
  return false;
}

type Deps = { fetchImpl?: typeof fetch; config?: () => Promise<GeoIpConfig> };

async function configFromIntegrations(): Promise<GeoIpConfig> {
  const cfg = await getIntegrationsConfig();
  return cfg.geoIp ?? {};
}

/** One address → city/region/country, or null when the provider is off, the address is private, or the lookup failed. */
export async function lookupIp(ip: string | null | undefined, deps: Deps = {}): Promise<SessionLocation | null> {
  if (!ip || isPrivateAddress(ip)) return null;
  const config = await (deps.config ?? configFromIntegrations)();
  const provider = config.provider ?? 'NONE';
  if (provider === 'NONE') return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    if (provider === 'IPAPI') {
      const res = await fetchImpl(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country`);
      if (!res.ok) return null;
      const body = (await res.json()) as { status?: string; city?: string; regionName?: string; country?: string };
      if (body.status !== 'success') return null;
      return { city: body.city ?? null, region: body.regionName ?? null, country: body.country ?? null };
    }
    const query = config.token ? `?token=${encodeURIComponent(config.token)}` : '';
    const res = await fetchImpl(`https://ipinfo.io/${encodeURIComponent(ip)}/json${query}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { city?: string; region?: string; country?: string };
    return { city: body.city ?? null, region: body.region ?? null, country: body.country ?? null };
  } catch (err) {
    logger.warn('Geo-IP lookup failed', { provider, err });
    return null;
  }
}

/** The cached form of `lookupIp`. */
export async function locate(ip: string | null | undefined, deps: Deps = {}): Promise<SessionLocation | null> {
  if (!ip || isPrivateAddress(ip)) return null;
  const key = `geoip:${ip}`;
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as SessionLocation;
  } catch {
    /* the cache is a convenience */
  }
  const found = await lookupIp(ip, deps);
  if (found) {
    try {
      await redis.set(key, JSON.stringify(found), 'EX', CACHE_TTL_SECONDS);
    } catch {
      /* same */
    }
  }
  return found;
}

/** Fire-and-forget from `startSession`: stamps the row once the lookup lands. Never throws. */
export async function locateSession(sessionId: string, ip: string | null | undefined, deps: Deps = {}): Promise<void> {
  try {
    const found = await locate(ip, deps);
    if (found) await prismaTokensRepository.setLocation(sessionId, found);
  } catch (err) {
    logger.warn('Could not stamp a session with its location', { sessionId, err });
  }
}
