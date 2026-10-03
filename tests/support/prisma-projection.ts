import { GLOBAL_OMIT } from '../../src/shared/database/prisma';

/**
 * A stand-in for Prisma's result shaping, for tests that want to see exactly
 * what a repository's `select` / `include` / `omit` would let out of a full
 * row — without a database.
 *
 * Fixture rows are whole: every column, credentials and private facts
 * included, with relations nested as whole rows. `project` then applies the
 * arguments a repository passed the way Prisma does: a `select` names the
 * fields; otherwise every scalar column comes, less the model's `GLOBAL_OMIT`
 * (when `globalOmit` is on) and the read's own `omit`, plus the relations an
 * `include` names. Running a read with `globalOmit: false` shows what the
 * selects alone keep out — the second layer.
 */

const models = new WeakMap<object, string>();

/** Marks a fixture row with its model (the `GLOBAL_OMIT` key: `user`, `order`, …). */
export function row<T extends object>(model: string, fields: T): T {
  models.set(fields, model);
  return fields;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** A relation is a nested fixture row, or a list of them. */
const isRelation = (value: unknown): boolean =>
  (isPlainObject(value) && models.has(value)) || (Array.isArray(value) && value.length > 0 && value.every((item) => isPlainObject(item) && models.has(item)));

type Args = { select?: Record<string, unknown>; include?: Record<string, unknown>; omit?: Record<string, boolean> } | undefined;

export type ProjectionOptions = { globalOmit: boolean };

export function project(value: unknown, args: Args, options: ProjectionOptions): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => project(item, args, options));
  if (!isPlainObject(value)) return value;
  const model = models.get(value);
  const out: Record<string, unknown> = {};
  const nested = (relation: unknown, spec: unknown) => project(relation, spec === true ? undefined : (spec as Args), options);

  if (args?.select) {
    for (const [key, spec] of Object.entries(args.select)) {
      if (!spec) continue;
      // Relation counts are not rows: a fixture that carries `_count` hands it through as it is.
      if (key === '_count') {
        if (value[key] !== undefined) out[key] = value[key];
        continue;
      }
      const field = value[key];
      out[key] = isRelation(field) ? nested(field, spec) : (field ?? null);
    }
    return out;
  }

  const omitted = new Set<string>(options.globalOmit && model ? Object.keys((GLOBAL_OMIT as Record<string, object>)[model] ?? {}) : []);
  for (const [key, on] of Object.entries(args?.omit ?? {})) {
    if (on) omitted.add(key);
    else omitted.delete(key);
  }
  for (const [key, field] of Object.entries(value)) {
    if (!isRelation(field) && !omitted.has(key)) out[key] = field;
  }
  for (const [key, spec] of Object.entries(args?.include ?? {})) {
    if (spec) out[key] = nested(value[key], spec);
  }
  return out;
}

/** Every key anywhere in a JSON tree, with its path — `listing.publisher.user.passwordHash`. */
export function keyPaths(tree: unknown, at = ''): string[] {
  if (Array.isArray(tree)) return tree.flatMap((item, index) => keyPaths(item, `${at}[${index}]`));
  if (!isPlainObject(tree)) return [];
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = at ? `${at}.${key}` : key;
    return [path, ...keyPaths(value, path)];
  });
}

/** Columns that must never reach a response, whoever asks. */
export const SECRET_KEYS = [
  'passwordHash',
  'totpSecretEnc',
  'codeHash',
  'tokenHash',
  'completionOtp',
  'completionOtpPlain',
] as const;

/** The paths in a tree whose last key is one of `keys`. */
export function pathsEndingIn(tree: unknown, keys: readonly string[]): string[] {
  return keyPaths(tree).filter((path) => keys.includes(path.slice(path.lastIndexOf('.') + 1).replace(/\[\d+\]$/, '')));
}
