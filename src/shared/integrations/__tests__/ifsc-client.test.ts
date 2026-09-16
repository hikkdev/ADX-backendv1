import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The IFSC directory — Lot B (Q11/Q109).
 *
 * Three answers the caller has to tell apart: known, unknown, and no answer.
 * The third fails open, because a free public service being down must not
 * stop a party adding their bank account.
 */

const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../cache/redis', () => ({ redis }));

import { IFSC_CACHE_SECONDS, fetchIfsc, lookupIfsc } from '../ifsc-client';

const directoryRow = {
  IFSC: 'HDFC0001234',
  BANK: 'HDFC Bank',
  BRANCH: 'Koramangala',
  CITY: 'Bengaluru',
  STATE: 'Karnataka',
  NEFT: true,
  IMPS: true,
  RTGS: true,
};

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const notFound = () => ({ ok: false, status: 404, json: async () => 'Not Found' }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
});

describe('the three answers', () => {
  it('shapes a known code with its bank, branch and rails', async () => {
    const fetchImpl = vi.fn(async (_url: string) => ok(directoryRow));
    await expect(fetchIfsc('HDFC0001234', fetchImpl as never)).resolves.toEqual({
      ifsc: 'HDFC0001234',
      bank: 'HDFC Bank',
      branch: 'Koramangala',
      city: 'Bengaluru',
      state: 'Karnataka',
      neft: true,
      imps: true,
      rtgs: true,
      found: true,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://ifsc.razorpay.com/HDFC0001234');
  });

  it('reports a 404 as unknown, not as an outage', async () => {
    await expect(fetchIfsc('HDFC0009999', (async () => notFound()) as never)).resolves.toEqual({
      ifsc: 'HDFC0009999',
      found: false,
    });
  });

  it('answers null when the directory does not answer, so the caller can fail open', async () => {
    await expect(fetchIfsc('HDFC0001234', (async () => { throw new Error('ECONNRESET'); }) as never)).resolves.toBeNull();
    await expect(
      fetchIfsc('HDFC0001234', (async () => ({ ok: false, status: 502, json: async () => ({}) })) as never)
    ).resolves.toBeNull();
  });

  it('gives up after the timeout rather than holding the request', async () => {
    const slow = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    await expect(fetchIfsc('HDFC0001234', slow as never, 5)).resolves.toBeNull();
  });
});

describe('the lookup', () => {
  it('normalises the code and never asks the directory about a malformed one', async () => {
    const fetchImpl = vi.fn();
    await expect(lookupIfsc('  hdfc001 ', fetchImpl as never)).resolves.toEqual({ ifsc: 'HDFC001', found: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches a known code for thirty days and answers from the cache after', async () => {
    const fetchImpl = vi.fn(async () => ok(directoryRow));
    await lookupIfsc('hdfc0001234', fetchImpl as never);
    expect(redis.set).toHaveBeenCalledWith('ifsc:HDFC0001234', expect.any(String), 'EX', IFSC_CACHE_SECONDS);

    redis.get.mockResolvedValue(JSON.stringify({ ifsc: 'HDFC0001234', bank: 'HDFC Bank', found: true }));
    fetchImpl.mockClear();
    await expect(lookupIfsc('HDFC0001234', fetchImpl as never)).resolves.toMatchObject({ found: true, bank: 'HDFC Bank' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches a miss for a day only, and caches nothing when the directory was down', async () => {
    await lookupIfsc('HDFC0009999', (async () => notFound()) as never);
    expect(redis.set).toHaveBeenCalledWith('ifsc:HDFC0009999', expect.any(String), 'EX', 24 * 60 * 60);

    redis.set.mockClear();
    await lookupIfsc('HDFC0001234', (async () => { throw new Error('down'); }) as never);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('treats a broken cache as a miss rather than a failure', async () => {
    redis.get.mockRejectedValue(new Error('redis down'));
    redis.set.mockRejectedValue(new Error('redis down'));
    await expect(lookupIfsc('HDFC0001234', (async () => ok(directoryRow)) as never)).resolves.toMatchObject({ found: true });
  });
});
