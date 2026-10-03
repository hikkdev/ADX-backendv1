import { describe, expect, it, vi } from 'vitest';

/**
 * SL-1 — where a session signed in from.
 *
 * What is pinned: a private address is never looked up; NONE looks nothing
 * up; each provider's answer maps to city/region/country; a failing
 * provider answers null rather than throwing (a sign-in never waits on it).
 */
vi.mock('../../../../shared/cache', () => ({ redis: { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') } }));
vi.mock('../../tokens/prisma-tokens.repository', () => ({ prismaTokensRepository: { setLocation: vi.fn(async () => undefined) } }));

import { isPrivateAddress, locateSession, lookupIp } from '../geo-ip';
import { prismaTokensRepository } from '../../tokens/prisma-tokens.repository';

const answering = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('private addresses', () => {
  it('knows loopback, RFC 1918, link-local and v4-mapped forms', () => {
    for (const ip of ['127.0.0.1', '::1', '10.4.5.6', '192.168.1.20', '172.16.0.9', '172.31.255.1', '169.254.1.1', '::ffff:10.0.0.1', 'fd00::1'])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '49.205.1.1']) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('lookupIp', () => {
  it('looks nothing up for a private address or when the provider is NONE', async () => {
    const fetchImpl = answering(200, {});
    expect(await lookupIp('10.0.0.1', { fetchImpl, config: async () => ({ provider: 'IPAPI' }) })).toBeNull();
    expect(await lookupIp('49.205.1.1', { fetchImpl, config: async () => ({}) })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps ip-api.com and ipinfo.io answers to city, region and country', async () => {
    expect(await lookupIp('49.205.1.1', { fetchImpl: answering(200, { status: 'success', city: 'Bengaluru', regionName: 'Karnataka', country: 'India' }), config: async () => ({ provider: 'IPAPI' }) })).toEqual({ city: 'Bengaluru', region: 'Karnataka', country: 'India' });
    const ipinfo = answering(200, { city: 'Mumbai', region: 'Maharashtra', country: 'IN' });
    expect(await lookupIp('49.205.1.2', { fetchImpl: ipinfo, config: async () => ({ provider: 'IPINFO', token: 't0k' }) })).toEqual({ city: 'Mumbai', region: 'Maharashtra', country: 'IN' });
    expect((ipinfo as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('token=t0k');
  });

  it('answers null when the provider fails or refuses, never throwing', async () => {
    expect(await lookupIp('49.205.1.1', { fetchImpl: answering(200, { status: 'fail' }), config: async () => ({ provider: 'IPAPI' }) })).toBeNull();
    expect(await lookupIp('49.205.1.1', { fetchImpl: answering(429, {}), config: async () => ({ provider: 'IPINFO' }) })).toBeNull();
    const throwing = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof fetch;
    expect(await lookupIp('49.205.1.1', { fetchImpl: throwing, config: async () => ({ provider: 'IPAPI' }) })).toBeNull();
  });
});

describe('locateSession', () => {
  it('stamps the row when the lookup lands, and stays quiet when it does not', async () => {
    await locateSession('sess_1', '49.205.1.1', { fetchImpl: answering(200, { status: 'success', city: 'Pune', regionName: 'Maharashtra', country: 'India' }), config: async () => ({ provider: 'IPAPI' }) });
    expect(prismaTokensRepository.setLocation).toHaveBeenCalledWith('sess_1', { city: 'Pune', region: 'Maharashtra', country: 'India' });
    vi.mocked(prismaTokensRepository.setLocation).mockClear();
    await locateSession('sess_2', '127.0.0.1', { fetchImpl: answering(200, {}), config: async () => ({ provider: 'IPAPI' }) });
    expect(prismaTokensRepository.setLocation).not.toHaveBeenCalled();
  });
});
