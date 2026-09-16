import { describe, expect, it } from 'vitest';

/**
 * G11-1: the step-ladder vocabulary GET /config/schema serves names every
 * proof — `proofOptions: [{ key, label }]` beside the bare `proofs` list
 * the editor already reads — so the console can print "Check in" rather
 * than CHECK_IN, and "Government ID front" rather than govIdFrontUrl.
 */

import {
  AGENT_JOB_PROOF_LABELS,
  AGENT_JOB_PROOFS,
  EMPLOYEE_INTAKE_PROOF_LABELS,
  EMPLOYEE_INTAKE_PROOFS,
  REQUIRED_AGENT_JOB_PROOFS,
  REQUIRED_EMPLOYEE_INTAKE_PROOFS,
  stepLadderVocabulary,
} from '../step-ladder';

describe('the step-ladder vocabulary — a label per proof key', () => {
  it('names every agent-job proof, in the order of the keys, and keeps the bare list', () => {
    const vocabulary = stepLadderVocabulary({ proofs: AGENT_JOB_PROOFS, required: REQUIRED_AGENT_JOB_PROOFS, labels: AGENT_JOB_PROOF_LABELS });
    expect(vocabulary.proofs).toEqual(['PICKUP', 'CHECK_IN', 'CONDITION', 'INSTALLATION']);
    expect(vocabulary.proofOptions).toEqual([
      { key: 'PICKUP', label: 'Material pickup' },
      { key: 'CHECK_IN', label: 'Check in' },
      { key: 'CONDITION', label: 'Site condition' },
      { key: 'INSTALLATION', label: 'Installation' },
    ]);
    expect(vocabulary.requiredProofs).toEqual(['CHECK_IN', 'CONDITION', 'INSTALLATION']);
  });

  it('names every employee-intake proof', () => {
    const vocabulary = stepLadderVocabulary({ proofs: EMPLOYEE_INTAKE_PROOFS, required: REQUIRED_EMPLOYEE_INTAKE_PROOFS, labels: EMPLOYEE_INTAKE_PROOF_LABELS });
    expect(vocabulary.proofOptions.map((p) => p.key)).toEqual([...EMPLOYEE_INTAKE_PROOFS]);
    expect(vocabulary.proofOptions.find((p) => p.key === 'govIdFrontUrl')).toEqual({ key: 'govIdFrontUrl', label: 'Government ID front' });
    expect(vocabulary.proofOptions.find((p) => p.key === 'panSignatureUrl')).toEqual({ key: 'panSignatureUrl', label: 'PAN signature' });
    expect(vocabulary.proofOptions.every((p) => p.label.length > 0)).toBe(true);
  });

  it('every key in each vocabulary has a label — a proof the code checks is never nameless', () => {
    expect(Object.keys(AGENT_JOB_PROOF_LABELS).sort()).toEqual([...AGENT_JOB_PROOFS].sort());
    expect(Object.keys(EMPLOYEE_INTAKE_PROOF_LABELS).sort()).toEqual([...EMPLOYEE_INTAKE_PROOFS].sort());
  });
});
