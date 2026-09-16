import { z } from 'zod';
import { summariseChanges, type ChangeSummary } from './flow-schema';

/**
 * The step-ladder vocabulary — Lot G (Q126/Q141): the third shape under
 * `flows`, for the two checklists the console may now edit beside the
 * listing wizard and the onboarding ladder.
 *
 *   - `flows.agent-job` — the A1–A8 job checklist the agent app climbs: each
 *     step's title, copy and the proofs the submit gate waits for. `orders`
 *     reads it through `getFlow('agent-job')` and builds the evidence
 *     requirements from it, falling back to its code ladder when the key is
 *     absent or does not fit — exactly as `users` does with the onboarding
 *     template.
 *   - `flows.employee-intake` — the intake ladder HR climbs on an employee's
 *     behalf at the KYC desk: which documents, in what order, under what
 *     copy. `kyc/employee` reads it the same way.
 *
 * Both share one shape — a list of steps, each naming the proofs it collects
 * — and differ only in the proof vocabulary: an evidence kind on a job, a
 * column of `EmployeeKyc` at the desk. The vocabulary is fixed here so the
 * console can only ask for a proof the code knows how to check.
 */

export const AGENT_JOB_FLOW_KEY = 'agent-job';
export const EMPLOYEE_INTAKE_FLOW_KEY = 'employee-intake';

/** What the job's submit gate can check — the OrderPhoto kinds and the check-in. */
export const AGENT_JOB_PROOFS = ['PICKUP', 'CHECK_IN', 'CONDITION', 'INSTALLATION'] as const;
export type AgentJobProof = (typeof AGENT_JOB_PROOFS)[number];
/** The three the gate has always waited for; a ladder that drops one is refused. */
export const REQUIRED_AGENT_JOB_PROOFS: readonly AgentJobProof[] = ['CHECK_IN', 'CONDITION', 'INSTALLATION'];
/** G11-1: what the console prints for each key — the vocabulary names its proofs. */
export const AGENT_JOB_PROOF_LABELS: Readonly<Record<AgentJobProof, string>> = {
  PICKUP: 'Material pickup',
  CHECK_IN: 'Check in',
  CONDITION: 'Site condition',
  INSTALLATION: 'Installation',
};

/** The `EmployeeKyc` columns the desk records — the same set `kyc/employee`'s schema takes. */
export const EMPLOYEE_INTAKE_PROOFS = [
  'govIdFrontUrl',
  'govIdBackUrl',
  'panNumber',
  'panFrontUrl',
  'panSignatureUrl',
  'addressProofUrl',
  'selfieUrl',
  'bankProofUrl',
] as const;
export type EmployeeIntakeProof = (typeof EMPLOYEE_INTAKE_PROOFS)[number];
/** What the record must hold before the desk can verify it. */
export const REQUIRED_EMPLOYEE_INTAKE_PROOFS: readonly EmployeeIntakeProof[] = ['govIdFrontUrl', 'panFrontUrl', 'addressProofUrl', 'selfieUrl'];
/** G11-1: what the console prints for each column. */
export const EMPLOYEE_INTAKE_PROOF_LABELS: Readonly<Record<EmployeeIntakeProof, string>> = {
  govIdFrontUrl: 'Government ID front',
  govIdBackUrl: 'Government ID back',
  panNumber: 'PAN number',
  panFrontUrl: 'PAN card',
  panSignatureUrl: 'PAN signature',
  addressProofUrl: 'Address proof',
  selfieUrl: 'Live selfie',
  bankProofUrl: 'Bank proof',
};

const key = z.string().trim().min(1).max(64);
const text = z.string().trim().min(1).max(300);

export interface StepLadderSpec<P extends readonly [string, ...string[]]> {
  proofs: P;
  required: readonly P[number][];
}

/**
 * One shape, parameterised by its proof vocabulary. `version` and
 * `updatedAt` are stamped by the PATCH, never sent; `description` is the
 * sentence the flow list prints under the key (Q126).
 */
export function stepLadderSchema<P extends readonly [string, ...string[]]>(spec: StepLadderSpec<P>) {
  const proofSchema = z
    .object({
      key: z.enum(spec.proofs),
      /** The line the gate prints while the proof is missing. */
      label: text,
    })
    .strict();

  const stepSchema = z
    .object({
      key,
      /** The counter in the header — "Step 5 of 8". Two screens may share one. */
      number: z.number().int().min(1).max(99),
      title: text,
      subtitle: z.string().trim().max(300).optional(),
      hint: z.string().trim().max(1000).optional(),
      cta: z.string().trim().max(80).optional(),
      proofs: z.array(proofSchema).max(12),
    })
    .strict();

  return z
    .object({
      label: text.optional(),
      description: z.string().trim().max(500).optional(),
      /** G13-B: who climbs it — a short phrase. */
      audience: z.string().trim().min(1).max(80).optional(),
      version: z.number().int().min(1).optional(),
      updatedAt: z.string().optional(),
      steps: z.array(stepSchema).min(1).max(40),
    })
    .strict()
    .superRefine((ladder, ctx) => {
      const seenKeys = new Set<string>();
      const seenProofs = new Map<string, number>();
      ladder.steps.forEach((step, s) => {
        if (seenKeys.has(step.key)) ctx.addIssue({ code: 'custom', path: ['steps', s, 'key'], message: `Step key \`${step.key}\` is used twice` });
        seenKeys.add(step.key);
        step.proofs.forEach((proof, p) => {
          const earlier = seenProofs.get(proof.key);
          if (earlier !== undefined) {
            ctx.addIssue({ code: 'custom', path: ['steps', s, 'proofs', p, 'key'], message: `Proof \`${proof.key}\` is already collected by step \`${ladder.steps[earlier]!.key}\`` });
          } else {
            seenProofs.set(proof.key, s);
          }
        });
      });
      const missing = spec.required.filter((proof) => !seenProofs.has(proof));
      if (missing.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['steps'], message: `No step collects ${missing.join(', ')}` });
      }
    });
}

export const agentJobLadderSchema = stepLadderSchema({ proofs: AGENT_JOB_PROOFS, required: REQUIRED_AGENT_JOB_PROOFS });
export const employeeIntakeLadderSchema = stepLadderSchema({ proofs: EMPLOYEE_INTAKE_PROOFS, required: REQUIRED_EMPLOYEE_INTAKE_PROOFS });

/** The shape, generic over its proof vocabulary. */
export interface LadderProof<P extends string = string> {
  key: P;
  label: string;
}
export interface LadderStep<P extends string = string> {
  key: string;
  number: number;
  title: string;
  subtitle?: string | undefined;
  hint?: string | undefined;
  cta?: string | undefined;
  proofs: LadderProof<P>[];
}
export interface StepLadder<P extends string = string> {
  label?: string | undefined;
  description?: string | undefined;
  audience?: string | undefined;
  version?: number | undefined;
  updatedAt?: string | undefined;
  steps: LadderStep<P>[];
}
export type AgentJobLadder = StepLadder<AgentJobProof>;
export type EmployeeIntakeLadder = StepLadder<EmployeeIntakeProof>;

/** Steps across a ladder, for the audit row. */
export function ladderSteps(ladder: unknown): { name: string; step: unknown }[] {
  if (!ladder || typeof ladder !== 'object') return [];
  const steps = (ladder as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((step, i) => ({ name: String((step as { key?: unknown })?.key ?? i), step }));
}

export function ladderDiff(before: unknown, after: unknown): { steps: ChangeSummary } {
  return { steps: summariseChanges(ladderSteps(before), ladderSteps(after), (s) => s.name) };
}

/** The document GET /config/schema serves for the two ladders. G11-1: `proofOptions` names each key, in the order of `proofs`. */
export function stepLadderVocabulary(spec: { proofs: readonly string[]; required: readonly string[]; labels: Readonly<Record<string, string>> }) {
  return {
    proofs: [...spec.proofs],
    proofOptions: spec.proofs.map((key) => ({ key, label: spec.labels[key] ?? key })),
    requiredProofs: [...spec.required],
    proof: { key: 'Proof — one of `proofs`', label: 'string — printed while the proof is missing' },
    step: {
      key: 'string — unique on the ladder',
      number: 'int — the counter in the header; two screens may share one',
      title: 'string',
      subtitle: 'string?',
      hint: 'string?',
      cta: 'string?',
      proofs: 'Proof[] — what this step collects; empty for a step that only explains',
    },
    ladder: {
      label: 'string?',
      description: 'string? — printed under the key in the flow list',
      audience: 'string? — who climbs it, a short phrase (at most 80 characters); the code default when absent',
      version: 'int — stamped by the server, bumped on every PATCH',
      updatedAt: 'ISO string — stamped by the server',
      steps: 'Step[] — in order',
    },
    rules: [
      'step keys are unique',
      'every proof key is one of `proofs`',
      'a proof is collected by at most one step',
      'every proof in `requiredProofs` is collected by some step',
    ],
  };
}
