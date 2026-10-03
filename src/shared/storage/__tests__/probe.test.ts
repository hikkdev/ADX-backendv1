import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The storage probe is documented as bounded and never throwing. It took the
 * dev server down on 25 September 2026 anyway, with an unhandled rejection:
 * the timeout timer is armed before the storage config is awaited, and when
 * that await outlasted the timeout, the timeout promise rejected before
 * `Promise.race` had attached a handler to it.
 *
 * Both sides of the race can be left behind — the timeout when setup is
 * slow, the probe when the timeout wins and the probe fails afterwards —
 * and both are pinned here. An unhandled rejection anywhere in the test
 * process fails the test, which is what makes this a real check.
 */

const config = vi.hoisted(() => ({
  /** How long `getEffectiveStorageConfig` takes to answer; the test sets it. */
  delayMs: 0,
  /** What the local probe's access check does after the config arrives. */
  access: async (): Promise<void> => undefined,
}));

vi.mock('../../integrations/integration-config', () => ({
  getEffectiveStorageConfig: async () => {
    await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    return { provider: 'local' };
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        mkdir: async () => undefined,
        access: () => config.access(),
      },
    },
  };
});

import { probeStorage } from '../storage';

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  config.delayMs = 0;
  config.access = async () => undefined;
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

/** Let every timer in the probe fire and every microtask settle. */
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the storage probe never throws', () => {
  it('answers ok when storage answers in time', async () => {
    const result = await probeStorage(200);
    expect(result.ok).toBe(true);
    await settle(250);
    expect(unhandled).toEqual([]);
  });

  /* The crash: setup outlasts the timeout, so the timer fires before the race
     is listening. */
  it('answers not-ok, and leaves nothing unhandled, when the config is slower than the timeout', async () => {
    config.delayMs = 60;
    const result = await probeStorage(20);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/exceeded 20ms/);
    await settle(120);
    expect(unhandled).toEqual([]);
  });

  /* The mirror: the timeout wins the race, and the probe fails later with
     nobody listening. */
  it('leaves nothing unhandled when the probe fails after the timeout already won', async () => {
    config.access = async () => {
      await settle(60);
      throw new Error('bucket vanished');
    };
    const result = await probeStorage(20);
    expect(result.ok).toBe(false);
    await settle(120);
    expect(unhandled).toEqual([]);
  });

  it('reports a fast failure as not-ok rather than throwing', async () => {
    config.access = async () => {
      throw new Error('EACCES: permission denied');
    };
    const result = await probeStorage(200);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/EACCES/);
    await settle(250);
    expect(unhandled).toEqual([]);
  });
});
