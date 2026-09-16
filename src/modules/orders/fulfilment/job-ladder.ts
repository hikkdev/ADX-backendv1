import { logger } from '../../../shared/logging';
import { AGENT_JOB_FLOW_KEY, agentJobLadderSchema, getFlow, type AgentJobLadder, type AgentJobProof } from '../../app-config';

/**
 * The agent's job ladder — Lot G (Q126/Q141): the A1–A8 checklist as data.
 *
 * The agent app draws eight steps (`job-steps.ts` in the app: OFFER, PICKUP,
 * TRAVEL, CHECK_IN, BEFORE, INSTALL, AFTER/SUBMIT, COMPLETE), and the submit
 * gate here waits for the proofs the on-site steps collect. Both the copy and
 * the proofs are now read from `flows.agent-job` through `getFlow`, checked
 * against the vocabulary `app-config` keeps, and fall back to the ladder
 * below when the key is absent or does not fit — exactly as `users` serves
 * the onboarding manifest. The code ladder is the frames' own wording, so
 * until the console edits it the phone reads back what was drawn.
 *
 * What a proof means to the gate is fixed in code (`fulfilmentEvidence`):
 * `CHECK_IN` is the scan or the self-install stamp, `CONDITION` and
 * `INSTALLATION` are photographs of those kinds on file, `PICKUP` the one
 * taken at the counter. The ladder says which of them a job waits for and
 * what to print while one is missing; it cannot invent a proof the code has
 * no way to check.
 */
export const CODE_AGENT_JOB_LADDER: AgentJobLadder = {
  label: 'Agent job',
  description: "The A1–A8 job checklist the agent app climbs — each step's title, copy and the proofs the submit gate waits for.",
  version: 1,
  steps: [
    { key: 'OFFER', number: 1, title: 'Job offer', subtitle: 'Take it or hand it back within the window.', cta: 'Accept job', proofs: [] },
    {
      key: 'PICKUP',
      number: 2,
      title: 'Material pickup',
      subtitle: 'Collect the material and check it over.',
      hint: 'Match the size and the finish against the order before you leave the counter.',
      cta: 'Collected',
      proofs: [],
    },
    { key: 'TRAVEL', number: 3, title: 'On the way', subtitle: 'Your position is shared with the publisher while you travel.', cta: 'I have arrived', proofs: [] },
    {
      key: 'CHECK_IN',
      number: 4,
      title: 'Site QR verification',
      subtitle: "Scan the spot's own code, standing at the spot.",
      cta: 'Scan',
      proofs: [{ key: 'CHECK_IN', label: 'Checked in at the site' }],
    },
    {
      key: 'BEFORE',
      number: 5,
      title: 'Site condition',
      subtitle: 'Photograph the site as you found it.',
      hint: 'A wide shot and a close-up; report the site if it cannot take the installation.',
      cta: 'Continue',
      proofs: [{ key: 'CONDITION', label: 'Site photographed before install' }],
    },
    { key: 'INSTALL', number: 6, title: 'Installation', subtitle: 'Put it up.', cta: 'Installed', proofs: [] },
    {
      key: 'AFTER',
      number: 7,
      title: 'Finished work',
      subtitle: 'Photograph the advertisement in place, then review and submit.',
      cta: 'Submit installation',
      proofs: [{ key: 'INSTALLATION', label: 'Advertisement photographed in place' }],
    },
    { key: 'COMPLETE', number: 8, title: 'Completion', subtitle: "The publisher's code, then ADX approves.", cta: 'Done', proofs: [] },
  ],
};

export type JobLadderView = AgentJobLadder & { source: 'config' | 'code' };

/**
 * The ladder as it stands: the stored flow when it fits the vocabulary,
 * otherwise the code's. A row that cannot be read is the code ladder too —
 * a config outage must not stop an agent submitting a job.
 */
export async function jobLadder(): Promise<JobLadderView> {
  let flow: Record<string, unknown> | null = null;
  try {
    flow = await getFlow(AGENT_JOB_FLOW_KEY);
  } catch (err) {
    logger.warn('flows.agent-job could not be read; serving the code ladder', { err: err instanceof Error ? err.message : String(err) });
  }
  if (!flow) return { ...CODE_AGENT_JOB_LADDER, source: 'code' };
  const parsed = agentJobLadderSchema.safeParse(flow);
  if (!parsed.success) {
    logger.warn('flows.agent-job does not fit the ladder vocabulary; serving the code ladder', {
      version: flow['version'],
      issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
    return { ...CODE_AGENT_JOB_LADDER, source: 'code' };
  }
  return { ...parsed.data, source: 'config' };
}

/** The proofs the ladder collects, in step order — what the submit gate waits for. */
export function ladderProofs(ladder: AgentJobLadder): { key: AgentJobProof; label: string; step: string }[] {
  return ladder.steps.flatMap((step) => step.proofs.map((proof) => ({ key: proof.key, label: proof.label, step: step.key })));
}
