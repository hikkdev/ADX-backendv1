import { logger } from '../../../shared/logging';
import { EMPLOYEE_INTAKE_FLOW_KEY, employeeIntakeLadderSchema, getFlow, type EmployeeIntakeLadder, type EmployeeIntakeProof } from '../../app-config';

/**
 * The employee intake ladder — Lot G (Q126/Q141): the desk's checklist as
 * data.
 *
 * HR records an employee's documents on their behalf (`PUT /employee-kyc/:id`)
 * and the desk draws the steps to walk through: which documents, in what
 * order, under what copy. That list is now `flows.employee-intake`, read
 * through `getFlow`, checked against the vocabulary `app-config` keeps —
 * the proofs are `EmployeeKyc` columns — and falling back to the ladder
 * below when the key is absent or does not fit, exactly as `orders` reads
 * its job ladder and `users` the onboarding template.
 *
 * `intakeProgress` lays a record over the ladder: each proof `met` when the
 * column holds a value, each step `complete` when all of its proofs are.
 */
export const CODE_EMPLOYEE_INTAKE_LADDER: EmployeeIntakeLadder = {
  label: 'Employee intake',
  description: "The intake ladder HR climbs on an employee's behalf at the KYC desk — which documents, in what order.",
  version: 1,
  steps: [
    {
      key: 'IDENTITY',
      number: 1,
      title: 'Government ID',
      subtitle: 'Aadhaar, passport or driving licence — front, and the back where there is one.',
      cta: 'Next',
      proofs: [
        { key: 'govIdFrontUrl', label: 'Government ID, front' },
        { key: 'govIdBackUrl', label: 'Government ID, back' },
      ],
    },
    {
      key: 'PAN',
      number: 2,
      title: 'PAN',
      subtitle: 'The card, the number typed beside it, and the signature.',
      cta: 'Next',
      proofs: [
        { key: 'panNumber', label: 'PAN number' },
        { key: 'panFrontUrl', label: 'PAN card' },
        { key: 'panSignatureUrl', label: 'Signature on the PAN card' },
      ],
    },
    {
      key: 'ADDRESS',
      number: 3,
      title: 'Address proof',
      subtitle: 'A utility bill, rent agreement or bank statement.',
      cta: 'Next',
      proofs: [{ key: 'addressProofUrl', label: 'Proof of address' }],
    },
    {
      key: 'SELFIE',
      number: 4,
      title: 'Live selfie',
      subtitle: 'Taken at the desk, not from the library.',
      cta: 'Next',
      proofs: [{ key: 'selfieUrl', label: 'Live selfie' }],
    },
    {
      key: 'BANK',
      number: 5,
      title: 'Bank proof',
      subtitle: 'A cancelled cheque or a passbook page, for payroll.',
      cta: 'Record',
      proofs: [{ key: 'bankProofUrl', label: 'Bank proof' }],
    },
  ],
};

export type IntakeLadderView = EmployeeIntakeLadder & { source: 'config' | 'code' };

/** The ladder as it stands: the stored flow when it fits, the code's otherwise (a row that cannot be read included). */
export async function employeeIntakeLadder(): Promise<IntakeLadderView> {
  let flow: Record<string, unknown> | null = null;
  try {
    flow = await getFlow(EMPLOYEE_INTAKE_FLOW_KEY);
  } catch (err) {
    logger.warn('flows.employee-intake could not be read; serving the code ladder', { err: err instanceof Error ? err.message : String(err) });
  }
  if (!flow) return { ...CODE_EMPLOYEE_INTAKE_LADDER, source: 'code' };
  const parsed = employeeIntakeLadderSchema.safeParse(flow);
  if (!parsed.success) {
    logger.warn('flows.employee-intake does not fit the ladder vocabulary; serving the code ladder', {
      version: flow['version'],
      issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return { ...CODE_EMPLOYEE_INTAKE_LADDER, source: 'code' };
  }
  return { ...parsed.data, source: 'config' };
}

export interface IntakeProgress {
  version: number;
  source: 'config' | 'code';
  steps: { key: string; number: number; title: string; complete: boolean; proofs: { key: EmployeeIntakeProof; label: string; met: boolean }[] }[];
  /** Proofs met over proofs asked, across the ladder. */
  met: number;
  total: number;
}

/** A record laid over the ladder: what the desk has, and what is still to collect. Null record = nothing recorded yet. */
export function intakeProgress(ladder: IntakeLadderView, record: Partial<Record<EmployeeIntakeProof, unknown>> | null): IntakeProgress {
  const has = (column: EmployeeIntakeProof): boolean => {
    const value = record?.[column];
    return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
  };
  const steps = ladder.steps.map((step) => {
    const proofs = step.proofs.map((proof) => ({ key: proof.key, label: proof.label, met: has(proof.key) }));
    return { key: step.key, number: step.number, title: step.title, complete: proofs.every((proof) => proof.met), proofs };
  });
  const all = steps.flatMap((step) => step.proofs);
  return { version: ladder.version ?? 1, source: ladder.source, steps, met: all.filter((proof) => proof.met).length, total: all.length };
}
