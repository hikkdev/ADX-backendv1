import { DEFAULT_ESIGN_POLICY, type EsignPolicy } from '../../../shared/esign';
import type { AgreementKind } from '../../../shared/database';
import type { SigningRow } from './esign.repository';

/**
 * DS-1: what the signing rail asks of modules above it. `agreements` imports
 * `shared/*` and `uploads` only — the policy is a platform setting
 * (`app-config`, which reaches `users`), the messages go through
 * `notifications` (which reaches `app-config`), and what happens once a
 * document is signed belongs to whoever opened it (an employee's console
 * invitation, say). Each is a port filled in `bootstrap/register-modules`.
 *
 * Unregistered: the policy is the default (e-signing off, so nothing is
 * ever asked), no message goes out, and completion runs no hook — the
 * request still records what the provider said.
 */

/* ── the policy ─────────────────────────────────────────────────────── */

export type EsignPolicyPort = { current(): Promise<EsignPolicy> };

let policyPort: EsignPolicyPort | null = null;

export function registerEsignPolicyPort(port: EsignPolicyPort | null): void {
  policyPort = port;
}

export async function esignPolicy(): Promise<EsignPolicy> {
  if (!policyPort) return DEFAULT_ESIGN_POLICY;
  return policyPort.current();
}

/* ── the messages ────────────────────────────────────────────────────── */

export type EsignMessage =
  | { event: 'AGREEMENT_SIGNATURE_REQUESTED'; request: SigningRow; deepLink: string }
  | { event: 'AGREEMENT_SIGNED'; request: SigningRow }
  | { event: 'AGREEMENT_SIGNATURE_EXPIRED'; request: SigningRow };

export type EsignNotifyPort = {
  /** Tell the signer — by their user when they have one, else at the address on the request. */
  send(message: EsignMessage): Promise<void>;
};

let notifyPort: EsignNotifyPort | null = null;

export function registerEsignNotifyPort(port: EsignNotifyPort | null): void {
  notifyPort = port;
}

export async function sendEsignMessage(message: EsignMessage): Promise<void> {
  if (!notifyPort) return;
  await notifyPort.send(message);
}

/* ── what happens once it is signed ──────────────────────────────────── */

export type SigningCompletionHook = (request: SigningRow) => Promise<void>;

const completionHooks = new Map<AgreementKind, SigningCompletionHook[]>();

/** The owning module says what a completed signature of `kind` sets in motion. Several may listen. */
export function onSigningCompleted(kind: AgreementKind, hook: SigningCompletionHook): void {
  const list = completionHooks.get(kind) ?? [];
  list.push(hook);
  completionHooks.set(kind, list);
}

export async function runCompletionHooks(request: SigningRow): Promise<void> {
  for (const hook of completionHooks.get(request.kind) ?? []) await hook(request);
}

/** Tests: forget every hook. */
export function resetSigningHooks(): void {
  completionHooks.clear();
}
