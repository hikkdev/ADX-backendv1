import { ApiError } from '../../shared/errors';
import { APP_ENUMS } from './app-enums';
import {
  CATEGORY_PLANS_KEY,
  FLOW_SNAPSHOTS_KEPT,
  PREVIOUS_CONFIG_KEY,
  flowSnapshotKey,
  flowSnapshotPrefix,
} from './app-config.repository';
import { prismaAppConfigRepository as repository } from './prisma-app-config.repository';
import { canonicalJson, enumGroupSchema, summariseChanges, wizardFlowSchema, wizardScreens, type ChangeSummary } from './flow-schema';
import { onboardingTemplateSchema, templateDiff } from './onboarding-template';
import { AGENT_JOB_FLOW_KEY, EMPLOYEE_INTAKE_FLOW_KEY, agentJobLadderSchema, employeeIntakeLadderSchema, ladderDiff } from './step-ladder';

/**
 * Served when no config row has been written yet, so a fresh install still
 * boots the agent app with a usable set of enums.
 */
const FALLBACK_CONFIG = {
  enums: APP_ENUMS,
  flows: {},
};

/** The `flows.onboarding` key — the one flow with the ladder shape rather than the wizard's. */
export const ONBOARDING_FLOW_KEY = 'onboarding';
/** The listing wizard's key — the first flow, and the one the apps' `fields.tsx` renders. */
export const LISTING_FLOW_KEY = 'listing';

export type FlowShape = 'wizard' | 'ladder' | 'steps';

/**
 * Lot G (Q126/Q141): the four flows the editor knows by name, with the
 * label and sentence the list prints for one that has not been stored yet.
 * The two step ladders are read by `orders` and `kyc/employee` through
 * `getFlow`, each with its code ladder as the fallback, so a key absent from
 * the row is still a flow — one the console has not taken over yet.
 */
export const KNOWN_FLOWS: readonly { key: string; shape: FlowShape; label: string; description: string; audience: string }[] = [
  {
    key: LISTING_FLOW_KEY,
    shape: 'wizard',
    label: 'Listing',
    description: "The publisher's listing wizard — screens and branches per venue kind, rendered by both apps.",
    audience: 'Publishers',
  },
  {
    key: ONBOARDING_FLOW_KEY,
    shape: 'ladder',
    label: 'Onboarding',
    description: 'The DR 08 onboarding ladder per party and account type — the KYC steps a phone climbs.',
    audience: 'Publishers and advertisers',
  },
  {
    key: AGENT_JOB_FLOW_KEY,
    shape: 'steps',
    label: 'Agent job',
    description: "The A1–A8 job checklist the agent app climbs — each step's title, copy and the proofs the submit gate waits for.",
    audience: 'Agents',
  },
  {
    key: EMPLOYEE_INTAKE_FLOW_KEY,
    shape: 'steps',
    label: 'Employee intake',
    description: "The intake ladder HR climbs on an employee's behalf at the KYC desk — which documents, in what order.",
    audience: 'Employees',
  },
];

const shapeOf = (key: string): FlowShape => KNOWN_FLOWS.find((flow) => flow.key === key)?.shape ?? 'wizard';

type ConfigDocument = { flows?: Record<string, unknown>; enums?: Record<string, unknown> } & Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Every flow object served carries a `version` (Q83): a flow the wholesale
 * PUT or an old seed wrote without one is version 1, so an app can always
 * stamp what it rendered. The row itself is left as written.
 */
function withVersions(value: object): object {
  const document = value as ConfigDocument;
  if (!isObject(document.flows)) return value;
  const flows: Record<string, unknown> = {};
  for (const [key, flow] of Object.entries(document.flows)) {
    flows[key] = isObject(flow) && typeof flow['version'] !== 'number' ? { ...flow, version: 1 } : flow;
  }
  return { ...document, flows };
}

export async function getAppConfig(): Promise<object> {
  const row = await repository.find();
  return row ? withVersions(row.value as object) : FALLBACK_CONFIG;
}

/* ── The flow editor's routes (Q83, Q148) ────────────────────────────── */

export interface FlowSummary {
  key: string;
  version: number;
  updatedAt: string | null;
  label: string | null;
  /** Q126: the sentence under the key. */
  description: string | null;
  /** G13-B: who climbs the flow — a short phrase ('Publishers and advertisers', 'Agents', 'Employees'); the code default until stored. */
  audience: string | null;
  /** `wizard` is screens and branches; `ladder` is the onboarding template; `steps` a step ladder (Q141). */
  shape: FlowShape;
  /** False for a known key the row does not hold yet — served from the code ladder, version 0. */
  stored: boolean;
}

/**
 * GET /config/flows — every key under `flows`, its version and when it last
 * moved; Q141: the four known keys are always listed, a missing one at
 * version 0 with the code's label and description, so the console can offer
 * to take it over.
 */
export async function listFlows(): Promise<FlowSummary[]> {
  const row = await repository.find();
  const document = isObject(row?.value) ? (row!.value as ConfigDocument) : {};
  const flows = isObject(document.flows) ? document.flows : {};
  const keys = [...KNOWN_FLOWS.map((flow) => flow.key), ...Object.keys(flows).filter((key) => !KNOWN_FLOWS.some((flow) => flow.key === key))];
  return keys.map((key) => {
    const known = KNOWN_FLOWS.find((flow) => flow.key === key);
    const flow = flows[key];
    if (!isObject(flow)) {
      return {
        key,
        version: 0,
        updatedAt: null,
        label: known?.label ?? null,
        description: known?.description ?? null,
        audience: known?.audience ?? null,
        shape: shapeOf(key),
        stored: false,
      };
    }
    return {
      key,
      version: typeof flow['version'] === 'number' ? (flow['version'] as number) : 1,
      updatedAt: typeof flow['updatedAt'] === 'string' ? (flow['updatedAt'] as string) : (row?.updatedAt?.toISOString() ?? null),
      label: typeof flow['label'] === 'string' ? (flow['label'] as string) : (known?.label ?? null),
      description: typeof flow['description'] === 'string' ? (flow['description'] as string) : (known?.description ?? null),
      audience: typeof flow['audience'] === 'string' ? (flow['audience'] as string) : (known?.audience ?? null),
      shape: shapeOf(key),
      stored: true,
    };
  });
}

/**
 * E10-2: one refusal the editor can point at — the full Zod path as
 * segments (`['screens', '2', 'fields', '1', 'kind']`) and as the pointer
 * the console prints (`screens[2].fields[1].kind`), with the message.
 * Zod's flattened form drops everything under the first key, so an error
 * three levels down read as "screens: invalid" with nothing to highlight.
 */
export interface FlowIssue {
  path: string[];
  pointer: string;
  message: string;
  code: string;
}

export function flowIssuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string; code: string }[] }): FlowIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment));
    const pointer = issue.path.reduce<string>(
      (acc, segment) => (typeof segment === 'number' ? `${acc}[${segment}]` : acc ? `${acc}.${String(segment)}` : String(segment)),
      '',
    );
    return { path, pointer, message: issue.message, code: issue.code };
  });
}

/**
 * Validates a flow body against the vocabulary its key selects. Throws the
 * 400 the console reads: `details.issues` (E10-2) beside the flattened form,
 * which stays one release for a console still reading `fieldErrors`.
 */
export function parseFlow(key: string, body: unknown): Record<string, unknown> {
  const schema =
    key === ONBOARDING_FLOW_KEY
      ? onboardingTemplateSchema
      : key === AGENT_JOB_FLOW_KEY
        ? agentJobLadderSchema
        : key === EMPLOYEE_INTAKE_FLOW_KEY
          ? employeeIntakeLadderSchema
          : wizardFlowSchema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The flow does not fit the vocabulary', { ...parsed.error.flatten(), issues: flowIssuesOf(parsed.error) });
  }
  return parsed.data as Record<string, unknown>;
}

export interface FlowPatchResult {
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  summary: Record<string, ChangeSummary>;
}

/**
 * PATCH /config/flows/:key — one flow replaced, the rest of the row left
 * alone. The row it replaces goes to `main:previous` first, the flow it
 * replaces to `flows.<key>:v<N>` (the last five kept), and the version is
 * bumped so the apps can say which one they rendered. A body that names a
 * `version` other than the current one is a stale editor: 409.
 */
export async function patchFlow(key: string, body: unknown): Promise<FlowPatchResult> {
  const next = parseFlow(key, body);
  const row = await repository.find();
  const document: ConfigDocument = isObject(row?.value) ? { ...(row!.value as ConfigDocument) } : { ...FALLBACK_CONFIG };
  const flows = isObject(document.flows) ? { ...document.flows } : {};
  const current = isObject(flows[key]) ? (flows[key] as Record<string, unknown>) : null;
  const currentVersion = current ? (typeof current['version'] === 'number' ? (current['version'] as number) : 1) : 0;

  if (current && typeof next['version'] === 'number' && next['version'] !== currentVersion) {
    throw new ApiError(409, 'CONFLICT', `The flow is at version ${currentVersion}; the editor was on ${next['version']}`, {
      currentVersion,
    });
  }

  const stamped = { ...next, version: currentVersion + 1, updatedAt: new Date().toISOString() };
  if (row) await repository.saveByKey(PREVIOUS_CONFIG_KEY, row.value as object);
  if (current) await snapshotFlow(key, { ...current, version: currentVersion });
  await repository.save({ ...document, flows: { ...flows, [key]: stamped } });

  const summary: Record<string, ChangeSummary> =
    key === ONBOARDING_FLOW_KEY
      ? templateDiff(current, stamped)
      : shapeOf(key) === 'steps'
        ? ladderDiff(current, stamped)
        : { screens: summariseChanges(wizardScreens(current), wizardScreens(stamped), (s) => s.name) };
  return { before: current, after: stamped, summary };
}

async function snapshotFlow(key: string, flow: Record<string, unknown>): Promise<void> {
  await repository.saveByKey(flowSnapshotKey(key, flow['version'] as number), flow);
  const prefix = flowSnapshotPrefix(key);
  const versions = (await repository.listByPrefix(prefix))
    .map((row) => Number(row.key.slice(prefix.length)))
    .filter((version) => Number.isInteger(version))
    .sort((a, b) => b - a);
  for (const stale of versions.slice(FLOW_SNAPSHOTS_KEPT)) await repository.deleteByKey(flowSnapshotKey(key, stale));
}

/**
 * `npm run seed:config` — Lot F (the Lot E verifier's minor). The seed
 * writes the shipped flows through the same door as the editor, so the
 * history the editor keeps is kept here too:
 *
 *  - a flow whose content is **byte-equal** to the live one (keys sorted,
 *    `version` and `updatedAt` aside) keeps its version — a seed re-run is
 *    not an edit, and the phones must not be told the ladder moved;
 *  - a flow whose content differs is bumped by one, and the flow it
 *    replaces is snapshotted as `flows.<key>:v<N>` (the last five kept),
 *    exactly as `PATCH /config/flows/:key` does — so a party mid-ladder on
 *    the old version is still served it;
 *  - a fresh row starts every flow at version 1;
 *  - the rest of the row (the enums, anything else) is replaced as given.
 *
 * Returns the versions written, for the script to print.
 */
export async function seedAppConfig(input: {
  flows: Record<string, Record<string, unknown>>;
  enums: Record<string, unknown>;
}): Promise<Record<string, { version: number; changed: boolean }>> {
  const row = await repository.find();
  const document: ConfigDocument = isObject(row?.value) ? { ...(row!.value as ConfigDocument) } : {};
  const currentFlows = isObject(document.flows) ? document.flows : {};
  const flows: Record<string, unknown> = { ...currentFlows };
  const report: Record<string, { version: number; changed: boolean }> = {};

  for (const [key, next] of Object.entries(input.flows)) {
    const current = isObject(currentFlows[key]) ? (currentFlows[key] as Record<string, unknown>) : null;
    if (!current) {
      flows[key] = { ...next, version: 1 };
      report[key] = { version: 1, changed: true };
      continue;
    }
    const currentVersion = typeof current['version'] === 'number' ? (current['version'] as number) : 1;
    const changed = flowContent(current) !== flowContent(next);
    if (!changed) {
      flows[key] = { ...current, version: currentVersion };
      report[key] = { version: currentVersion, changed: false };
      continue;
    }
    await snapshotFlow(key, { ...current, version: currentVersion });
    flows[key] = { ...next, version: currentVersion + 1, updatedAt: new Date().toISOString() };
    report[key] = { version: currentVersion + 1, changed: true };
  }

  await repository.save({ ...document, flows, enums: input.enums });
  return report;
}

/** A flow's content for the byte-equal test: keys sorted, the version and the stamp set aside. */
function flowContent(flow: Record<string, unknown>): string {
  return canonicalJson({ ...flow, version: undefined, updatedAt: undefined });
}

/**
 * One flow, at the version asked for. The current one when no version is
 * named or it is the current version; otherwise the `flows.<key>:v<N>`
 * snapshot, or the current one again when that snapshot is gone — five are
 * kept, and a party mid-ladder on an older one is served today's rather
 * than nothing. `null` when the key is not in the row at all.
 */
export async function getFlow(key: string, version?: number): Promise<Record<string, unknown> | null> {
  const row = await repository.find();
  const document = isObject(row?.value) ? (row!.value as ConfigDocument) : {};
  const current = isObject(document.flows) && isObject(document.flows[key]) ? (document.flows[key] as Record<string, unknown>) : null;
  if (!current) return null;
  const currentVersion = typeof current['version'] === 'number' ? (current['version'] as number) : 1;
  if (version === undefined || version === currentVersion) return { ...current, version: currentVersion };
  const snapshot = await repository.findByKey(flowSnapshotKey(key, version));
  return isObject(snapshot?.value) ? (snapshot!.value as Record<string, unknown>) : { ...current, version: currentVersion };
}

/** PATCH /config/enums/:group — one group replaced; the flows and the other groups untouched. */
export async function patchEnumGroup(
  group: string,
  body: unknown,
): Promise<{ before: unknown[] | null; after: unknown[]; summary: ChangeSummary }> {
  const parsed = enumGroupSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The enum group does not fit the vocabulary', { ...parsed.error.flatten(), issues: flowIssuesOf(parsed.error) });
  }
  const row = await repository.find();
  const document: ConfigDocument = isObject(row?.value) ? { ...(row!.value as ConfigDocument) } : { ...FALLBACK_CONFIG };
  const enums = isObject(document.enums) ? { ...document.enums } : {};
  const before = Array.isArray(enums[group]) ? (enums[group] as unknown[]) : null;
  if (row) await repository.saveByKey(PREVIOUS_CONFIG_KEY, row.value as object);
  await repository.save({ ...document, enums: { ...enums, [group]: parsed.data } });
  const valueOf = (entry: unknown) => String(isObject(entry) ? (entry['value'] ?? '?') : entry);
  return { before, after: parsed.data, summary: summariseChanges(before ?? [], parsed.data, valueOf) };
}

/**
 * Replaces the row wholesale, keeping the version it replaces under
 * `main:previous` so `revertAppConfig` has something to go back to. One step
 * of history, not a log: the audit trail records who changed what and when;
 * this only makes the last change undoable.
 */
export async function saveAppConfig(value: object) {
  const current = await repository.find();
  if (current) await repository.saveByKey(PREVIOUS_CONFIG_KEY, current.value as object);
  const row = await repository.save(value);
  return row.value;
}

/** Puts `main:previous` back as `main`. 409 when no PUT has happened yet. */
export async function revertAppConfig(): Promise<object> {
  const previous = await repository.findByKey(PREVIOUS_CONFIG_KEY);
  if (!previous) throw new ApiError(409, 'CONFLICT', 'There is no previous config to revert to');
  const current = await repository.find();
  const row = await repository.save(previous.value as object);
  // The step just undone becomes the new "previous", so a revert is itself undoable.
  if (current) await repository.saveByKey(PREVIOUS_CONFIG_KEY, current.value as object);
  return row.value as object;
}

/**
 * Default milestone plan for a listing category, from the `categoryPlans`
 * config row. Returns null when unset or malformed rather than throwing —
 * milestone auto-assignment treats "no plan" as "nothing to do".
 */
export async function getCategoryPlanId(category: string): Promise<string | null> {
  const row = await repository.findByKey(CATEGORY_PLANS_KEY);
  const value = row?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[category];
  return typeof candidate === 'string' ? candidate : null;
}

/**
 * A named config row as an object, or null when unset or malformed. DR 05
 * keeps the tier ladder's thresholds and the per-tier support lines here so
 * the app never holds a copy of a table the backend marks provisional.
 */
export async function getConfigObject(key: string): Promise<Record<string, unknown> | null> {
  const row = await repository.findByKey(key);
  const value = row?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function saveConfigObject(key: string, value: Record<string, unknown>) {
  const row = await repository.saveByKey(key, value);
  return row.value as Record<string, unknown>;
}
