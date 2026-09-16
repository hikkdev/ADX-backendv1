import { createHash } from 'crypto';
import { ApiError } from '../../shared/errors';
import { invalidate, readThrough } from '../../shared/cache';
import { logger } from '../../shared/logging';
import {
  canonicalKey,
  declaredFeatures,
  FEATURE_KINDS,
  FEATURE_SURFACES,
  findDeclaration,
  knownAliases,
  LEGACY_FLAG_KEYS,
  type FeatureDeclaration,
  type FeatureKind,
  type FeatureSurface,
  type RegistryEntry,
} from '../../shared/features';
import { prismaFeatureFlagsRepository as repository } from './prisma-feature-flags.repository';
import type { FlagPosition, FlagStateRow, FlagWithLastChange, FlagWriteInput } from './feature-flags.repository';
import type { FeatureFlag, FeatureFlagChange } from '../../shared/database';
import { userLabels, type UserLabel } from './user-labels.port';
import { subjectCity } from './subject.port';
import { emitFlagChange } from './flag-change.port';
import { readRegistryDocument } from './registry-file';
import { checkRegistry, type RegistryCheck } from './registry-check';
import { FLAG_STATES, type FlagStateFilter, type ListFlagsQuery, type RolloutInput } from './feature-flags.schema';
import type { FlagAnswer, FlagState, FlagSubject, Rollout } from './feature-flags.types';

/**
 * Feature flags — Lot A (Q31), rebuilt around the registry in Lot G
 * (answers 144-146).
 *
 * A flag is a switch, a percentage, a variant and a rollout rule. `enabled:
 * false` is off for everyone; `enabled: true` with `rolloutPercent: 100` and
 * no rollout rule is on for everyone; anything between is a deterministic
 * slice, bucketed on sha1(key + subject) so the same person keeps the same
 * answer for the life of the rollout, narrowed by role and city, with named
 * accounts on regardless. A caller with no subject and a partial rollout is
 * told no — an anonymous evaluation that flickered between requests would be
 * worse than a late launch.
 *
 * Unknown keys are false. A flag that has not been declared is not a flag
 * whose behaviour should be guessed, and a typo in a call site must fail
 * closed rather than switching a half-built feature on. A key that IS
 * declared but has no row yet — the boot window before
 * `ensureFeatureRegistry` lands — answers from the declaration's `launch`.
 */

export const FLAG_STATE_CACHE_KEY = 'feature-flags:state';
export const FLAG_STATE_TTL_SECONDS = 30;
export const CHANGE_HISTORY_LIMIT = 50;

const APP_SURFACES: readonly FeatureSurface[] = ['APP_USER', 'APP_AGENT'];

export type { FlagAnswer, FlagState, FlagSubject, Rollout } from './feature-flags.types';

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return out.length > 0 ? out : undefined;
}

/** A stored rollout, read defensively: a column somebody hand-edited must not take the evaluator down. */
export function parseRollout(value: unknown): Rollout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const rollout: Rollout = {};
  const roles = stringList(raw['roles']);
  const cities = stringList(raw['cities']);
  const userIds = stringList(raw['userIds']);
  if (roles) rollout.roles = roles;
  if (cities) rollout.cities = cities;
  if (userIds) rollout.userIds = userIds;
  return Object.keys(rollout).length > 0 ? rollout : null;
}

function toState(row: FlagStateRow): FlagState {
  return {
    key: row.key,
    enabled: row.enabled,
    rolloutPercent: row.rolloutPercent,
    variant: row.variant ?? null,
    variants: row.variants ?? [],
    rollout: parseRollout(row.rollout),
    surfaces: row.surfaces ?? [],
  };
}

/** The state a declaration implies before its row exists: on at 100 for `launch: 'on'`, off for `'dark'`. */
function declaredState(declaration: FeatureDeclaration): FlagState {
  return {
    key: declaration.key,
    enabled: declaration.launch === 'on',
    rolloutPercent: 100,
    variant: null,
    variants: [...declaration.variants],
    rollout: null,
    surfaces: [...declaration.surfaces],
  };
}

async function flagState(): Promise<FlagState[]> {
  const rows = await readThrough(FLAG_STATE_CACHE_KEY, FLAG_STATE_TTL_SECONDS, () => repository.listState());
  const state = rows.map(toState);
  const known = new Set(state.map((flag) => flag.key));
  for (const declaration of declaredFeatures()) {
    if (!known.has(declaration.key)) state.push(declaredState(declaration));
  }
  return state;
}

/** The keys a row for this feature may sit under: the registry key first, then any legacy alias of it. */
function keysFor(key: string): string[] {
  const canonical = canonicalKey(key);
  const legacy = Object.entries(knownAliases())
    .filter(([, target]) => target === canonical)
    .map(([alias]) => alias);
  return [...new Set([canonical, ...legacy, key])];
}

/** The row for a key: the canonical key first, then a legacy alias — a Lot A row not folded yet still answers. */
function findState(state: readonly FlagState[], key: string): FlagState | undefined {
  for (const candidate of keysFor(key)) {
    const found = state.find((flag) => flag.key === candidate);
    if (found) return found;
  }
  return undefined;
}

/** 0-99, stable for a (key, subject) pair. */
export function bucketFor(key: string, subjectId: string): number {
  const digest = createHash('sha1').update(`${key}${subjectId}`).digest('hex');
  // The first 8 hex digits are plenty of entropy for 100 buckets and stay
  // inside a safe integer, which the whole digest would not.
  return parseInt(digest.slice(0, 8), 16) % 100;
}

function sameCity(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The evaluation itself, with no I/O — what the tests pin.
 *
 * Order (answer 146): off is off. Then the named accounts: a `userIds` list
 * is an allowlist, and a subject on it is on regardless of the percentage,
 * the roles and the city — a subject not on it is off. Otherwise the
 * percentage bucket, then the roles, then the city, each an AND.
 */
export function evaluate(flag: FlagState | undefined, subject?: FlagSubject | string | null): FlagAnswer {
  const off: FlagAnswer = { enabled: false, variant: null };
  if (!flag || !flag.enabled) return off;
  const who: FlagSubject = typeof subject === 'string' ? { id: subject } : (subject ?? {});
  const on: FlagAnswer = { enabled: true, variant: flag.variant };
  const rollout = flag.rollout;

  if (rollout?.userIds?.length) {
    return who.id && rollout.userIds.includes(who.id) ? on : off;
  }

  if (flag.rolloutPercent <= 0) return off;
  if (flag.rolloutPercent < 100) {
    if (!who.id) return off;
    if (bucketFor(flag.key, who.id) >= flag.rolloutPercent) return off;
  }
  if (rollout?.roles?.length) {
    if (!who.roles?.some((role) => rollout.roles!.includes(role))) return off;
  }
  if (rollout?.cities?.length) {
    if (!who.city || !rollout.cities.some((city) => sameCity(city, who.city!))) return off;
  }
  return on;
}

/** Whether any flag's rollout names a city — the one case the city port is worth a read. */
export function needsCity(state: readonly FlagState[]): boolean {
  return state.some((flag) => flag.enabled && (flag.rollout?.cities?.length ?? 0) > 0);
}

async function resolveSubject(state: readonly FlagState[], subject: FlagSubject): Promise<FlagSubject> {
  if (subject.city !== undefined || !subject.id || !needsCity(state)) return subject;
  return { ...subject, city: await subjectCity(subject.id) };
}

/**
 * Is this flag on for this caller? The one export other modules use.
 * `subjectId` is whatever the caller buckets on — a user id, or a party id
 * where the feature is the party's (instant booking is the publisher's);
 * `context` carries the roles and city the rollout rules read, and is
 * looked up through the city port when absent and needed.
 *
 * Cached 30s; a write invalidates, so a kill switch takes effect at once on
 * the instance that threw it and within the TTL everywhere else.
 */
export async function isFeatureEnabled(
  key: string,
  subjectId?: string | null,
  context?: Omit<FlagSubject, 'id'>,
): Promise<boolean> {
  return (await featureAnswer(key, { id: subjectId ?? null, ...(context ?? {}) })).enabled;
}

/** `{ enabled, variant }` for one flag and one caller — for a call site that runs two implementations. */
export async function featureAnswer(key: string, subject: FlagSubject): Promise<FlagAnswer> {
  const state = await flagState();
  const flag = findState(state, key);
  if (!flag) return { enabled: false, variant: null };
  return evaluate(flag, await resolveSubject(state, subject));
}

/**
 * Every flag as this caller sees it — what the apps boot with.
 *
 * `{ key: { enabled, variant } }` for every feature on an app surface (or a
 * row with no surface at all, which is a manual row nobody classified and
 * should stay visible), plus the flat boolean under each legacy alias
 * (`instant-booking: true`) for one release, because the shipped apps read
 * exactly that shape.
 */
export async function evaluateAllFor(subject: FlagSubject | string | null | undefined): Promise<Record<string, FlagAnswer | boolean>> {
  const state = await flagState();
  const who = await resolveSubject(state, typeof subject === 'string' ? { id: subject } : (subject ?? {}));
  const out: Record<string, FlagAnswer | boolean> = {};
  for (const flag of state) {
    if (flag.surfaces.length > 0 && !flag.surfaces.some((surface) => APP_SURFACES.includes(surface as FeatureSurface))) continue;
    out[flag.key] = evaluate(flag, who);
  }
  for (const [alias, canonical] of Object.entries(knownAliases())) {
    const flag = findState(state, canonical);
    if (flag) out[alias] = evaluate(flag, who).enabled;
  }
  return out;
}

/**
 * G11-2: every flag on every surface as this caller sees it — what
 * `GET /flags/me` answers the console, so its own evaluation (which surface
 * a screen is on, whose bucket, which variant) moves server-side and runs
 * the same evaluator the apps' `/app/flags` runs. `{ key: { enabled,
 * variant } }` only: no legacy booleans, which are the shipped apps' shape.
 */
export async function evaluateEverySurfaceFor(subject: FlagSubject | string | null | undefined): Promise<Record<string, FlagAnswer>> {
  const state = await flagState();
  const who = await resolveSubject(state, typeof subject === 'string' ? { id: subject } : (subject ?? {}));
  const out: Record<string, FlagAnswer> = {};
  for (const flag of [...state].sort((a, b) => a.key.localeCompare(b.key))) out[flag.key] = evaluate(flag, who);
  return out;
}

/* ── Ops surface ─────────────────────────────────────────────────────── */

/** E6: a change as the console reads it — the actor joined as `byUser`. */
export type FlagChangeView = FeatureFlagChange & { byUser: UserLabel };

export async function withActors(changes: FeatureFlagChange[]): Promise<FlagChangeView[]> {
  const labels = await userLabels(changes.map((change) => change.byUserId));
  return changes.map((change) => ({
    ...change,
    byUser: labels.get(change.byUserId) ?? { id: change.byUserId, name: null },
  }));
}

export type FlagView = Omit<FlagWithLastChange, 'changes'> & {
  changes: FlagChangeView[];
  rollout: Rollout | null;
  /** The keys this flag also answers to, so the console can show what a call site still names. */
  aliases: string[];
};

function aliasesOf(key: string): string[] {
  return Object.entries(knownAliases())
    .filter(([, canonical]) => canonical === key)
    .map(([alias]) => alias);
}

/** Rows to views: the rollout parsed, the aliases joined, the actors named — E6: one name lookup for the lot. */
export async function viewsOf(flags: FlagWithLastChange[]): Promise<FlagView[]> {
  const labels = await userLabels(flags.flatMap((flag) => flag.changes.map((change) => change.byUserId)));
  return flags.map((flag) => ({
    ...flag,
    rollout: parseRollout(flag.rollout),
    aliases: aliasesOf(flag.key),
    changes: flag.changes.map((change) => ({
      ...change,
      byUser: labels.get(change.byUserId) ?? { id: change.byUserId, name: null },
    })),
  }));
}

/**
 * L-B: the console's own filters, evaluated server-side. `owner` is an
 * exact match, case-insensitively; `q` is a substring over key, description,
 * owner and aliases, the way the console's search box reads.
 */
export type FlagFilter = Pick<ListFlagsQuery, 'surface' | 'kind' | 'source' | 'state' | 'owner' | 'q'>;

/** A flag's position as a chip: ON; OFF (a switch somebody threw, or a manual row that is off); DARK_LAUNCH (registered, launched dark, never moved). */
export function flagStateOf(flag: Pick<FlagView, 'enabled' | 'source' | 'changes'>): FlagStateFilter {
  if (flag.enabled) return 'ON';
  return flag.source === 'REGISTERED' && flag.changes.length === 0 ? 'DARK_LAUNCH' : 'OFF';
}

type FlagFacet = 'surface' | 'kind' | 'state';

function matchesFilter(flag: FlagView, filter: FlagFilter, except?: FlagFacet): boolean {
  if (except !== 'surface' && filter.surface && !flag.surfaces.includes(filter.surface)) return false;
  if (except !== 'kind' && filter.kind && flag.kind !== filter.kind) return false;
  if (filter.source && flag.source !== filter.source) return false;
  if (except !== 'state' && filter.state && flagStateOf(flag) !== filter.state) return false;
  if (filter.owner && (flag.owner ?? '').trim().toLowerCase() !== filter.owner.trim().toLowerCase()) return false;
  if (filter.q) {
    const needle = filter.q.trim().toLowerCase();
    const haystack = [flag.key, flag.description ?? '', flag.owner ?? '', ...flag.aliases];
    if (!haystack.some((text) => text.toLowerCase().includes(needle))) return false;
  }
  return true;
}

export async function listFlags(filter: FlagFilter = {}): Promise<FlagView[]> {
  const views = await viewsOf(await repository.list());
  return views.filter((flag) => matchesFilter(flag, filter));
}

/** L-B: the chip histograms — surface, kind, state — each counted with its own facet removed from the filter, so a chip row stays a way back out. */
export interface FlagCounts {
  surface: Record<FeatureSurface, number>;
  kind: Record<FeatureKind, number>;
  state: Record<FlagStateFilter, number>;
}

export interface FlagListPage {
  items: FlagView[];
  total: number;
  page: number;
  pageSize: number;
  counts: FlagCounts;
}

function histogram<K extends string>(keys: readonly K[], rows: readonly FlagView[], of: (flag: FlagView) => readonly K[]): Record<K, number> {
  const out = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const flag of rows) for (const key of of(flag)) if (key in out) out[key] += 1;
  return out;
}

/** L-B: the list contract — `{ items, total, page, pageSize, counts }` — for `GET /flags?page&pageSize`. */
export async function pageFlags(query: FlagFilter & { page: number; pageSize: number }): Promise<FlagListPage> {
  const views = await viewsOf(await repository.list());
  const matching = views.filter((flag) => matchesFilter(flag, query));
  const start = (query.page - 1) * query.pageSize;
  return {
    items: matching.slice(start, start + query.pageSize),
    total: matching.length,
    page: query.page,
    pageSize: query.pageSize,
    counts: {
      surface: histogram(FEATURE_SURFACES, views.filter((flag) => matchesFilter(flag, query, 'surface')), (flag) => flag.surfaces as readonly FeatureSurface[]),
      kind: histogram(FEATURE_KINDS, views.filter((flag) => matchesFilter(flag, query, 'kind')), (flag) => [flag.kind as FeatureKind]),
      state: histogram(FLAG_STATES, views.filter((flag) => matchesFilter(flag, query, 'state')), (flag) => [flagStateOf(flag)]),
    },
  };
}

async function findFlagOrNull(key: string): Promise<FeatureFlag | null> {
  for (const candidate of keysFor(key)) {
    const flag = await repository.find(candidate);
    if (flag) return flag;
  }
  return null;
}

async function findFlag(key: string): Promise<FeatureFlag> {
  const flag = await findFlagOrNull(key);
  if (!flag) throw new ApiError(404, 'NOT_FOUND', 'Feature flag not found');
  return flag;
}

export async function getFlagChanges(key: string): Promise<FlagChangeView[]> {
  const flag = await findFlag(key);
  return withActors(await repository.changes(flag.key, CHANGE_HISTORY_LIMIT));
}

function positionOf(flag: FeatureFlag): FlagPosition {
  return {
    enabled: flag.enabled,
    rolloutPercent: flag.rolloutPercent,
    variant: flag.variant ?? null,
    rollout: parseRollout(flag.rollout),
  };
}

function cleanRollout(input: RolloutInput | null | undefined): Rollout | null {
  if (!input) return null;
  return parseRollout({
    roles: input.roles ? [...new Set(input.roles)] : undefined,
    cities: input.cities ? [...new Set(input.cities)] : undefined,
    userIds: input.userIds ? [...new Set(input.userIds)] : undefined,
  });
}

async function afterWrite(after: FlagWithLastChange, byUserId: string, rollback: boolean): Promise<void> {
  await invalidate(FLAG_STATE_CACHE_KEY);
  await emitFlagChange({
    flag: toState(after),
    changeId: after.changes[0]?.id ?? '',
    byUserId,
    rollback,
  });
}

export interface FlagWrite {
  before: FlagPosition;
  after: FlagWithLastChange;
}

/**
 * Moves a flag. A patch that names one field leaves the others where they
 * are — flipping a switch must not silently reset a rollout somebody spent
 * a week widening. The position before the write becomes `lastGoodState`,
 * which is what `rollbackFlag` restores; the flag change port fires after
 * the row is written so the apps refresh.
 */
export interface FlagPatch {
  enabled?: boolean;
  rolloutPercent?: number;
  variant?: string | null;
  rollout?: RolloutInput | null;
}

/** Whether the asked variant is one of the row's — null (the default implementation) always is. */
function acceptsVariant(flag: FeatureFlag, variant: string | null | undefined): boolean {
  return variant === undefined || variant === null || flag.variants.includes(variant);
}

/** The position a patch moves a row to: the fields named, the rest where they are. */
function planPatch(flag: FeatureFlag, patch: FlagPatch): { before: FlagPosition; next: FlagPosition } {
  const before = positionOf(flag);
  const next: FlagPosition = {
    enabled: patch.enabled ?? before.enabled,
    rolloutPercent: patch.rolloutPercent ?? before.rolloutPercent,
    variant: patch.variant === undefined ? before.variant : patch.variant,
    rollout: patch.rollout === undefined ? before.rollout : cleanRollout(patch.rollout),
  };
  return { before, next };
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Two positions that read the same — the rollout lists compared as sets, since their order carries nothing. */
export function samePosition(a: FlagPosition, b: FlagPosition): boolean {
  const left = parseRollout(a.rollout);
  const right = parseRollout(b.rollout);
  return (
    a.enabled === b.enabled &&
    a.rolloutPercent === b.rolloutPercent &&
    (a.variant ?? null) === (b.variant ?? null) &&
    sameList(left?.roles, right?.roles) &&
    sameList(left?.cities, right?.cities) &&
    sameList(left?.userIds, right?.userIds)
  );
}

export async function setFlag(key: string, patch: FlagPatch & { note?: string | null }, byUserId: string): Promise<FlagWrite> {
  const flag = await findFlag(key);
  if (!acceptsVariant(flag, patch.variant)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Not one of this feature\'s variants', {
      variant: patch.variant,
      variants: flag.variants,
    });
  }

  const { before, next } = planPatch(flag, patch);
  const after = await repository.update(
    flag.key,
    { ...next, lastGoodState: before },
    { byUserId, note: patch.note ?? null, rollbackOfId: null },
  );
  await afterWrite(after, byUserId, false);
  return { before, after };
}

/* ── L-B: the bulk write ─────────────────────────────────────────────── */

export interface FlagSkip {
  /** The key as it was asked for. */
  key: string;
  reason: string;
}

export interface BulkFlagResult<W extends FlagWrite = FlagWrite> {
  /** The keys written, in the order asked, each with the row as it now stands. */
  updated: W[];
  skipped: FlagSkip[];
}

/** One requested key resolved to its row — an alias resolves like `/:key`. */
interface ResolvedFlag {
  asked: string;
  flag: FeatureFlag;
}

/**
 * Every key resolved, or a 404 naming the ones that are not flags — the
 * whole batch refused, so nothing is half-applied. A key named twice over
 * (the alias and the registry key) is the same row, kept once: the later
 * request is skipped, naming the earlier.
 */
async function resolveAll(keys: readonly string[]): Promise<{ resolved: ResolvedFlag[]; skipped: FlagSkip[] }> {
  const found = await Promise.all(keys.map(async (asked) => ({ asked, flag: await findFlagOrNull(asked) })));
  const unknown = found.filter((item) => !item.flag).map((item) => item.asked);
  if (unknown.length > 0) throw new ApiError(404, 'NOT_FOUND', 'Feature flag not found', { keys: unknown });

  const resolved: ResolvedFlag[] = [];
  const skipped: FlagSkip[] = [];
  const seen = new Map<string, string>();
  for (const { asked, flag } of found as ResolvedFlag[]) {
    const earlier = seen.get(flag.key);
    if (earlier !== undefined) {
      skipped.push({ key: asked, reason: `the same flag as ${earlier}` });
      continue;
    }
    seen.set(flag.key, asked);
    resolved.push({ asked, flag });
  }
  return { resolved, skipped };
}

/** The batch written in one transaction, then the cache dropped and the port fired per key, as a single write does. */
async function writeBatch(writes: FlagWriteInput[], byUserId: string, rollback: boolean): Promise<FlagWithLastChange[]> {
  if (writes.length === 0) return [];
  const rows = await repository.updateMany(writes);
  for (const row of rows) await afterWrite(row, byUserId, rollback);
  return rows;
}

/**
 * L-B: the same patch `setFlag` applies, to every key in one transaction.
 * The whole batch is refused — nothing written — when a key is unknown
 * (404, naming them) or the asked variant is not one of a key's (400,
 * naming the keys and their lists). A key already at the asked position is
 * skipped: no change row, no `lastGoodState` overwritten with itself. Each
 * key written goes through the same path a single write does —
 * `lastGoodState`, the change row with the note, the port.
 */
export async function bulkSetFlags(keys: readonly string[], patch: FlagPatch, note: string, byUserId: string): Promise<BulkFlagResult> {
  const { resolved, skipped } = await resolveAll(keys);

  const refusing = resolved.filter(({ flag }) => !acceptsVariant(flag, patch.variant));
  if (refusing.length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Not one of these features\' variants', {
      variant: patch.variant,
      keys: refusing.map(({ flag }) => ({ key: flag.key, variants: flag.variants })),
    });
  }

  const planned: { before: FlagPosition; write: FlagWriteInput }[] = [];
  for (const { asked, flag } of resolved) {
    const { before, next } = planPatch(flag, patch);
    if (samePosition(before, next)) {
      skipped.push({ key: asked, reason: 'already at the asked position' });
      continue;
    }
    planned.push({ before, write: { key: flag.key, next: { ...next, lastGoodState: before }, change: { byUserId, note, rollbackOfId: null } } });
  }

  const rows = await writeBatch(planned.map((plan) => plan.write), byUserId, false);
  return { updated: rows.map((after, index) => ({ before: planned[index]!.before, after })), skipped };
}

/**
 * Lot G (answer 145): back to the position before the last write. The
 * current position becomes the new `lastGoodState`, so a rollback can itself
 * be rolled back; the change row names the change it undid.
 */
const NOTHING_TO_ROLL_BACK = 'this flag has not been moved since it was registered, so there is nothing to roll back to';

export type FlagRollback = FlagWrite & { restored: FlagPosition };

interface RollbackPlan {
  before: FlagPosition;
  restored: FlagPosition;
  write: FlagWriteInput;
}

/** The rollback path: what `lastGoodState` restores and the change it undoes — null when the flag has never moved. */
async function planRollback(flag: FeatureFlag, byUserId: string, note: string | null): Promise<RollbackPlan | null> {
  const before = positionOf(flag);
  const restored = flag.lastGoodState ? parseLastGoodState(flag.lastGoodState) : null;
  if (!restored) return null;
  const [last] = await repository.changes(flag.key, 1);
  return {
    before,
    restored,
    write: { key: flag.key, next: { ...restored, lastGoodState: before }, change: { byUserId, note, rollbackOfId: last?.id ?? null } },
  };
}

export async function rollbackFlag(key: string, byUserId: string, note?: string | null): Promise<FlagRollback> {
  const flag = await findFlag(key);
  const plan = await planRollback(flag, byUserId, note ?? null);
  if (!plan) throw new ApiError(409, 'CONFLICT', 'This flag has not been moved since it was registered, so there is nothing to roll back to');

  const after = await repository.update(plan.write.key, plan.write.next, plan.write.change);
  await afterWrite(after, byUserId, true);
  return { before: plan.before, after, restored: plan.restored };
}

/**
 * L-B: every key back to its `lastGoodState` through the rollback path
 * above, in one transaction; a key that has never moved is skipped with the
 * reason `/:key/rollback` would 409 with. Unknown keys refuse the batch.
 */
export async function bulkRollbackFlags(keys: readonly string[], note: string, byUserId: string): Promise<BulkFlagResult<FlagRollback>> {
  const { resolved, skipped } = await resolveAll(keys);

  const planned: RollbackPlan[] = [];
  for (const { asked, flag } of resolved) {
    const plan = await planRollback(flag, byUserId, note);
    if (!plan) {
      skipped.push({ key: asked, reason: NOTHING_TO_ROLL_BACK });
      continue;
    }
    planned.push(plan);
  }

  const rows = await writeBatch(planned.map((plan) => plan.write), byUserId, true);
  return { updated: rows.map((after, index) => ({ before: planned[index]!.before, after, restored: planned[index]!.restored })), skipped };
}

function parseLastGoodState(value: unknown): FlagPosition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['enabled'] !== 'boolean') return null;
  const percent = typeof raw['rolloutPercent'] === 'number' ? Math.min(100, Math.max(0, Math.round(raw['rolloutPercent']))) : 100;
  return {
    enabled: raw['enabled'],
    rolloutPercent: percent,
    variant: typeof raw['variant'] === 'string' ? raw['variant'] : null,
    rollout: parseRollout(raw['rollout']),
  };
}

/* ── The registry ────────────────────────────────────────────────────── */

export interface RegistrySyncResult {
  folded: string[];
  created: string[];
  updated: number;
  skipped: string[];
}

/** What the boot upsert writes for one feature: the declaration, widened by the committed document's surfaces. */
interface RegistrationInput {
  key: string;
  description: string;
  surfaces: FeatureSurface[];
  kind: FeatureKind;
  owner: string;
  variants: string[];
  launch: 'on' | 'dark';
}

function registrations(): RegistrationInput[] {
  const document = readRegistryDocument();
  const documented = new Map<string, RegistryEntry>((document?.features ?? []).map((entry) => [entry.key, entry]));
  const out = new Map<string, RegistrationInput>();
  for (const declaration of declaredFeatures()) {
    const entry = documented.get(declaration.key);
    out.set(declaration.key, {
      key: declaration.key,
      description: declaration.description,
      surfaces: [...new Set([...declaration.surfaces, ...(entry?.surfaces ?? [])])],
      kind: declaration.kind,
      owner: declaration.owner,
      variants: [...new Set([...declaration.variants, ...(entry?.variants ?? [])])],
      launch: declaration.launch,
    });
  }
  // Manifest-only features — a console screen, an app folder, a website
  // page — get a row too: the owner asked for EVERY feature to be listed.
  for (const entry of documented.values()) {
    if (out.has(entry.key)) continue;
    out.set(entry.key, {
      key: entry.key,
      description: entry.description,
      surfaces: [...entry.surfaces],
      kind: entry.kind,
      owner: entry.owner,
      variants: [...entry.variants],
      launch: entry.launch,
    });
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Boot: every declared feature becomes a row. A new feature arrives enabled
 * unless it launches dark; an existing REGISTERED row keeps its switch,
 * percentage, variant and rollout and only has its metadata refreshed; a
 * MANUAL row is never touched. The Lot A flags are folded under their
 * registry keys first, state and history carried over, so the console never
 * shows both `instant-booking` and `marketplace.instant-booking`.
 */
export async function ensureFeatureRegistry(): Promise<RegistrySyncResult> {
  const result: RegistrySyncResult = { folded: [], created: [], updated: 0, skipped: [] };
  for (const [oldKey, newKey] of Object.entries(LEGACY_FLAG_KEYS)) {
    if (await repository.foldLegacy(oldKey, newKey)) result.folded.push(oldKey);
  }

  const existing = new Map((await repository.list()).map((flag) => [flag.key, flag]));
  for (const input of registrations()) {
    const row = existing.get(input.key);
    if (!row) {
      await repository.createRegistered({ ...input, enabled: input.launch === 'on' });
      result.created.push(input.key);
      continue;
    }
    if (row.source === 'MANUAL') {
      result.skipped.push(input.key);
      continue;
    }
    await repository.updateRegistered(input);
    result.updated += 1;
  }
  await invalidate(FLAG_STATE_CACHE_KEY);
  if (result.created.length > 0 || result.folded.length > 0) {
    logger.info('feature registry synced', { created: result.created, folded: result.folded, updated: result.updated });
  }
  return result;
}

/** One line of `GET /flags/registry`: the committed document's entry, with the row as it stands. */
export type RegistryView = RegistryEntry & { flag: FlagView | null };

/**
 * The committed document merged with the rows — every surface, whether the
 * backend can see it or not. A row with no document entry (a MANUAL flag, or
 * a declaration newer than the last sync) is listed from the row alone so
 * nothing the console can switch is hidden from it.
 */
export async function registryView(): Promise<{ generatedBy: string | null; features: RegistryView[]; check: RegistryCheck }> {
  const document = readRegistryDocument();
  const rows = new Map((await listFlags()).map((flag) => [flag.key, flag]));
  const features: RegistryView[] = [];
  for (const entry of document?.features ?? []) {
    features.push({ ...entry, flag: rows.get(entry.key) ?? null });
    rows.delete(entry.key);
  }
  for (const flag of rows.values()) {
    const declaration = findDeclaration(flag.key);
    features.push({
      key: flag.key,
      surfaces: flag.surfaces,
      kind: flag.kind,
      owner: flag.owner ?? declaration?.owner ?? 'unowned',
      launch: declaration?.launch ?? (flag.enabled ? 'on' : 'dark'),
      description: flag.description ?? declaration?.description ?? '',
      variants: flag.variants,
      aliases: flag.aliases,
      routes: [...(declaration?.routes ?? [])],
      jobs: [...(declaration?.jobs ?? [])],
      paths: {},
      declaredIn: declaration ? ['backend'] : [],
      flag,
    });
  }
  features.sort((a, b) => a.key.localeCompare(b.key));
  // G11-2: is the committed document behind the code? The same verdict
  // `npm run features:check` prints, per surface, from the shared checker.
  return { generatedBy: document?.generatedBy ?? null, features, check: checkRegistry(document) };
}
