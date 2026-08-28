import { afterAll } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';

// src/lib/prisma and src/lib/redis open their connections at import time, so
// without this the worker keeps a live pool and a live socket and vitest hangs
// after the last assertion.
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
  redis.disconnect();
});
