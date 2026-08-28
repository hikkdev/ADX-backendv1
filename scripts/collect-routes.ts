/**
 * Registration-time route collector.
 *
 * Express 5 stores no path on its Layer objects — path-to-regexp v8 matchers
 * are opaque closures — so the router stack cannot be walked after the fact.
 * Instead the shared Router prototype is patched BEFORE `src/app` is loaded,
 * every registration is recorded in order, and the log is replayed into a
 * route tree.
 *
 * Used by scripts/route-inventory.ts (snapshot writer) and by
 * tests/architecture/route-inventory.test.ts (regression assertion), so both
 * measure the app exactly the same way.
 */
import express from 'express';

export type RouteEntry = {
  method: string;
  path: string;
  chain: string[];
};

export type RouteInventory = {
  generatedBy: string;
  routeCount: number;
  routes: RouteEntry[];
};

type Event =
  | { kind: 'mw'; owner: number; at: string; handler: string }
  | { kind: 'mount'; owner: number; at: string; child: number }
  | { kind: 'route'; owner: number; method: string; at: string; handlers: string[] };

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;

let collected: RouteEntry[] | null = null;

export async function collectRoutes(): Promise<RouteEntry[]> {
  // The Router prototype can only be patched once per process, and `src/app`
  // can only be loaded once, so memoise rather than double-register.
  if (collected) return collected;

  const events: Event[] = [];
  const ids = new WeakMap<object, number>();
  let nextId = 1;

  const idOf = (target: object): number => {
    let id = ids.get(target);
    if (id === undefined) {
      id = nextId++;
      ids.set(target, id);
    }
    return id;
  };

  const isRouter = (value: unknown): value is Function & { stack: unknown[] } =>
    typeof value === 'function' && Array.isArray((value as { stack?: unknown }).stack);

  const nameOf = (fn: unknown): string => (fn as Function)?.name || '<anon>';

  const normalise = (p: unknown): string => {
    if (typeof p === 'string') return p;
    if (Array.isArray(p)) return p.map(String).join('|');
    return String(p);
  };

  // Every Router() call gets a fresh intermediate object, so the shared
  // prototype carrying use/get/post/… sits two links up the chain. The
  // application delegates its own use/get/… into `this.router`, so patching
  // this single object captures app-level registrations too.
  const routerProto = Object.getPrototypeOf(Object.getPrototypeOf(express.Router()));

  const originalUse = routerProto.use;
  routerProto.use = function patchedUse(this: object, ...args: unknown[]) {
    const owner = idOf(this);
    const hasPath = typeof args[0] === 'string' || Array.isArray(args[0]);
    const at = hasPath ? normalise(args[0]) : '/';
    for (const handler of (hasPath ? args.slice(1) : args).flat()) {
      if (isRouter(handler)) events.push({ kind: 'mount', owner, at, child: idOf(handler) });
      else events.push({ kind: 'mw', owner, at, handler: nameOf(handler) });
    }
    return originalUse.apply(this, args as never);
  };

  for (const verb of VERBS) {
    const original = routerProto[verb];
    routerProto[verb] = function patchedVerb(this: object, ...args: unknown[]) {
      // `router.get('setting')` is the Express settings getter, not a route.
      if (args.length > 1) {
        events.push({
          kind: 'route',
          owner: idOf(this),
          method: verb.toUpperCase(),
          at: normalise(args[0]),
          handlers: args.slice(1).flat().map(nameOf),
        });
      }
      return original.apply(this, args as never);
    };
  }

  // Imported dynamically so it loads only after the prototype is patched.
  const { app } = await import('../src/app');

  const join = (prefix: string, segment: string): string => {
    if (segment === '/' || segment === '') return prefix || '/';
    const joined = `${prefix}${segment}`.replace(/\/{2,}/g, '/');
    return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
  };

  const routes: RouteEntry[] = [];

  const walk = (routerId: number, prefix: string, inherited: string[]): void => {
    const active = [...inherited];
    for (const event of events) {
      if (event.owner !== routerId) continue;
      if (event.kind === 'mw') {
        // Path-scoped middleware applies only under that path, so it does not
        // join the router-wide chain; unscoped middleware does.
        if (event.at === '/') active.push(event.handler);
        continue;
      }
      if (event.kind === 'mount') {
        walk(event.child, join(prefix, event.at), active);
        continue;
      }
      routes.push({
        method: event.method,
        path: join(prefix, event.at),
        chain: [...active, ...event.handlers],
      });
    }
  };

  walk(idOf((app as unknown as { router: object }).router), '', []);

  collected = routes;
  return routes;
}
