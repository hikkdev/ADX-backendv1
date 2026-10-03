import { afterAll } from 'vitest';
import { prisma } from '../src/shared/database/prisma';
import { redis } from '../src/shared/cache/redis';

// src/lib/prisma and src/lib/redis open their connections at import time, so
// without this the worker keeps a live pool and a live socket and vitest hangs
// after the last assertion.
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
  redis.disconnect();
});

// 2 Oct 2026: the suite never asks Digio to look a UPI ID up. `.env` may hold
// real Digio keys, so a test that reaches the lookup without stubbing `fetch`
// (or handing in a `fetchImpl`) is refused here — the client reads that as a
// network failure — instead of making a live call.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/digio\.in/i.test(url) && /\/upi\//i.test(url)) throw new Error('The test suite never calls Digio: stub fetch for the UPI lookup');
  return realFetch(input, init);
}) as typeof fetch;
