import { DIGIO_WORKFLOW_KEYS, isDigioWorkflowKey, type DigioWorkflowKey } from '../integrations/digio-workflows';
import {
  CHECK_TYPES,
  DEFAULT_UPI_CHECK,
  UPI_CHECK_MODES,
  isVerificationProviderName,
  type CheckType,
  type UpiCheckMode,
  type VerificationProviderName,
} from './checks';
import { defaultComposite, isCompositeStepKind, type CompositeStep, type CompositeStepKind } from './composites';

/**
 * Cashfree Phase 1 — the `verificationRouting` section of the integrations
 * row, and the defaults it lies over. Configuration, not code: which
 * provider answers which check, when a provider is left alone for a while,
 * what Cashfree runs in place of each Digio workflow, and three switches.
 *
 * The owner's decisions (1 Oct 2026) are the defaults:
 *   - HOSTED_KYC goes to Digio first, Cashfree Secure ID second; every
 *     other check goes to Cashfree Secure ID (nobody else answers them).
 *   - Five technical failures in ten minutes open a provider's breaker for
 *     five minutes.
 *   - A name match of 80 or more passes.
 *   - UPI IDs (2 Oct 2026): Digio's VPA lookup is the UPI check
 *     (`upiCheck: 'VPA_LOOKUP'`); UPI_VPA routes to Digio first and to
 *     Cashfree's penny drop second — which the router only asks when the
 *     account holder has just consented. A stored `upiCheck` is kept as
 *     stored, NONE included.
 *   - E-bis (2 Oct 2026): the hosted-KYC backup is OFF until the apps and
 *     the website can draw the Cashfree steps; ON, it is handed out only to
 *     a client that says it can (`supports: ['CASHFREE']`).
 *
 * Imports no module and nothing that reads the row: `integration-config.ts`
 * imports this file's types, so the reader of the row lives there.
 */

export type CheckRoute = { primary: VerificationProviderName; fallbacks: VerificationProviderName[] };
export type BreakerSettings = { failures: number; windowMinutes: number; cooldownMinutes: number };

/** What the row may hold: any subset, laid over the defaults. */
export interface VerificationRoutingConfig {
  checks?: Partial<Record<CheckType, { primary?: VerificationProviderName | undefined; fallbacks?: VerificationProviderName[] | undefined }>>;
  breaker?: Partial<BreakerSettings>;
  composites?: Partial<Record<DigioWorkflowKey, { step: CompositeStepKind; required?: boolean | undefined }[]>>;
  nameMatchMin?: number;
  upiCheck?: UpiCheckMode;
  hostedKycBackup?: 'ON' | 'OFF';
}

export interface VerificationSettings {
  checks: Record<CheckType, CheckRoute>;
  breaker: BreakerSettings;
  composites: Record<DigioWorkflowKey, CompositeStep[]>;
  nameMatchMin: number;
  upiCheck: UpiCheckMode;
  hostedKycBackup: 'ON' | 'OFF';
}

/** A primary and at most two fallbacks — three providers a check, never more. */
export const MAX_FALLBACKS = 2;
export const DEFAULT_BREAKER: BreakerSettings = { failures: 5, windowMinutes: 10, cooldownMinutes: 5 };
export const DEFAULT_NAME_MATCH_MIN = 80;

export function defaultCheckRoute(check: CheckType): CheckRoute {
  // Digio answers first for the hosted journey and for a UPI ID; Cashfree is the backup of both and the only provider of the rest.
  return check === 'HOSTED_KYC' || check === 'UPI_VPA' ? { primary: 'DIGIO', fallbacks: ['CASHFREE_SECURE_ID'] } : { primary: 'CASHFREE_SECURE_ID', fallbacks: [] };
}

function resolveRoute(check: CheckType, stored: VerificationRoutingConfig['checks']): CheckRoute {
  const fallback = defaultCheckRoute(check);
  const row = stored?.[check];
  if (!row) return fallback;
  const primary = isVerificationProviderName(row.primary) ? row.primary : fallback.primary;
  const fallbacks: VerificationProviderName[] = [];
  for (const name of row.fallbacks ?? fallback.fallbacks) {
    if (isVerificationProviderName(name) && name !== primary && !fallbacks.includes(name) && fallbacks.length < MAX_FALLBACKS) fallbacks.push(name);
  }
  return { primary, fallbacks };
}

const bounded = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= max ? Math.floor(value) : fallback;

function resolveComposite(key: DigioWorkflowKey, stored: VerificationRoutingConfig['composites']): CompositeStep[] {
  const override = stored?.[key];
  if (!Array.isArray(override) || override.length === 0) return defaultComposite(key);
  const steps: CompositeStep[] = [];
  for (const row of override) {
    if (!row || !isCompositeStepKind(row.step)) continue;
    if (steps.some((step) => step.step === row.step)) continue;
    steps.push({ step: row.step, required: row.required !== false });
  }
  return steps.length > 0 ? steps : defaultComposite(key);
}

/** The settings in force: the stored subset laid over the defaults. A stray value falls back rather than throws. */
export function resolveVerificationSettings(stored?: VerificationRoutingConfig | null): VerificationSettings {
  const nameMatchMin = stored?.nameMatchMin;
  const upiCheck = stored?.upiCheck;
  return {
    checks: Object.fromEntries(CHECK_TYPES.map((check) => [check, resolveRoute(check, stored?.checks)])) as Record<CheckType, CheckRoute>,
    breaker: {
      failures: bounded(stored?.breaker?.failures, DEFAULT_BREAKER.failures, 100),
      windowMinutes: bounded(stored?.breaker?.windowMinutes, DEFAULT_BREAKER.windowMinutes, 24 * 60),
      cooldownMinutes: bounded(stored?.breaker?.cooldownMinutes, DEFAULT_BREAKER.cooldownMinutes, 24 * 60),
    },
    composites: Object.fromEntries(DIGIO_WORKFLOW_KEYS.map((key) => [key, resolveComposite(key, stored?.composites)])) as Record<DigioWorkflowKey, CompositeStep[]>,
    nameMatchMin: typeof nameMatchMin === 'number' && nameMatchMin >= 0 && nameMatchMin <= 100 ? nameMatchMin : DEFAULT_NAME_MATCH_MIN,
    upiCheck: upiCheck && (UPI_CHECK_MODES as readonly string[]).includes(upiCheck) ? upiCheck : DEFAULT_UPI_CHECK,
    hostedKycBackup: stored?.hostedKycBackup === 'ON' ? 'ON' : 'OFF',
  };
}

/** The steps Cashfree runs in place of a Digio workflow; none for a key ADX does not know. */
export function compositeFor(key: string | null | undefined, settings: VerificationSettings): CompositeStep[] {
  return key && isDigioWorkflowKey(key) ? settings.composites[key] : [];
}
