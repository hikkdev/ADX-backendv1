/**
 * Route-inventory snapshot — the primary regression oracle for the
 * structure-only modular refactor.
 *
 * Express 5 stores no path on its Layer objects (path-to-regexp v8 matchers
 * are opaque closures), so the router stack cannot be walked after the fact.
 * Instead we patch the Router prototype BEFORE `src/app` is loaded and record
 * every registration in order, then replay that log into a route tree.
 *
 * What the snapshot pins down:
 *   - the exact set of METHOD + PATH pairs
 *   - the middleware chain length and order behind each one
 *   - registration order, which is load-bearing in this app: GET
 *     /api/v1/listings/:id/similar is deliberately registered before the
 *     authenticated listing router, and /api/v1/orders/:orderId/milestones
 *     deliberately after the order router.
 *
 * Usage:  npx tsx scripts/route-inventory.ts            # print JSON
 *         npx tsx scripts/route-inventory.ts --write    # write docs/route-inventory.json
 */
import fs from 'fs';
import path from 'path';
import express from 'express';

type Handler = { name: string; length: number };
type Event =
  | { kind: 'mw'; owner: number; at: string; handlers: Handler[] }
  | { kind: 'mount'; owner: number; at: string; child: number }
  | { kind: 'route'; owner: number; method: string; at: string; handlers: Handler[] };

const events: Event[] = [];
const ids = new WeakMap<object, number>();
let nextId = 1;

function idOf(target: object): number {
  let id = ids.get(target);
  if (id === undefined) {
    id = nextId++;
    ids.set(target, id);
  }
  return id;
}

function isRouter(value: unknown): value is Function & { stack: unknown[] } {
  return typeof value === 'function' && Array.isArray((value as { stack?: unknown }).stack);
}

function describe(fn: unknown): Handler {
  const f = fn as Function;
  return { name: f?.name || '<anon>', length: f?.length ?? 0 };
}

function normalise(p: unknown): string {
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) return p.map(String).join('|');
  return String(p);
}

// `express.Router()` returns a function whose prototype carries use/get/post/…
// Patching that shared prototype captures app.get/app.use too, because the
// application prototype delegates straight through to `this.router[method]`.
// Each Router() call gets a fresh intermediate object, so the shared
// prototype carrying use/get/post/… sits two links up the chain. The
// application delegates its own use/get/… straight into `this.router`, so
// patching this one object captures app-level registrations as well.
const routerProto = Object.getPrototypeOf(Object.getPrototypeOf(express.Router()));
const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'] as const;

const originalUse = routerProto.use;
routerProto.use = function patchedUse(this: object, ...args: unknown[]) {
  const owner = idOf(this);
  const hasPath = typeof args[0] === 'string' || Array.isArray(args[0]);
  const at = hasPath ? normalise(args[0]) : '/';
  const handlers = (hasPath ? args.slice(1) : args).flat();
  for (const h of handlers) {
    if (isRouter(h)) events.push({ kind: 'mount', owner, at, child: idOf(h) });
    else events.push({ kind: 'mw', owner, at, handlers: [describe(h)] });
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
        handlers: args.slice(1).flat().map(describe),
      });
    }
    return original.apply(this, args as never);
  };
}

// Loaded only after the prototype is patched.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { app } = require('../src/app') as { app: express.Express };

const appRouterId = idOf((app as unknown as { router: object }).router);

function join(prefix: string, segment: string): string {
  if (segment === '/' || segment === '') return prefix || '/';
  const joined = `${prefix}${segment}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

type Entry = { method: string; path: string; chain: string[] };
const inventory: Entry[] = [];

function walk(routerId: number, prefix: string, inherited: string[]): void {
  const active = [...inherited];
  for (const event of events) {
    if (event.owner !== routerId) continue;
    if (event.kind === 'mw') {
      // Path-scoped middleware applies only under that path, so it is not
      // added to the router-wide chain; unscoped middleware is.
      if (event.at === '/') active.push(...event.handlers.map((h) => h.name));
      continue;
    }
    if (event.kind === 'mount') {
      walk(event.child, join(prefix, event.at), active);
      continue;
    }
    inventory.push({
      method: event.method,
      path: join(prefix, event.at),
      chain: [...active, ...event.handlers.map((h) => h.name)],
    });
  }
}

walk(appRouterId, '', []);

const snapshot = {
  generatedBy: 'scripts/route-inventory.ts',
  routeCount: inventory.length,
  routes: inventory,
};
const json = `${JSON.stringify(snapshot, null, 2)}\n`;

if (process.argv.includes('--write')) {
  const out = path.resolve(__dirname, '../docs/route-inventory.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.log(`Wrote ${inventory.length} routes to ${path.relative(process.cwd(), out)}`);
} else {
  process.stdout.write(json);
}

process.exit(0);
