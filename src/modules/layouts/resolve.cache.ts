/**
 * LM-1: the public read's cache — in this process, sixty seconds.
 *
 * In memory rather than Redis on purpose. The key carries the live version
 * number, so a publish on another instance is a different key there within
 * one live-version lookup, and nothing needs invalidating across boxes; and
 * the home screens of both apps read this on every open, which must keep
 * answering when Redis is down (26 Sep 2026: Redis going away used to take
 * the API with it). A publish or restore here forgets the surface at once.
 */

export const LAYOUT_CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 2_000;

type Entry<T> = { at: number; value: T };
const store = new Map<string, Entry<unknown>>();

export async function cached<T>(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && now - hit.at < LAYOUT_CACHE_TTL_MS) return hit.value;
  const value = await load();
  if (store.size >= MAX_ENTRIES) {
    // Oldest first: a Map iterates in insertion order.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.delete(key);
  store.set(key, { at: now, value });
  return value;
}

/** Every cached answer for one surface — its live row and each resolved variant. */
export function forgetSurface(surface: string): void {
  for (const key of store.keys()) if (key.startsWith(`${surface}|`)) store.delete(key);
}

/** Tests: start empty. */
export function clearLayoutCache(): void {
  store.clear();
}
