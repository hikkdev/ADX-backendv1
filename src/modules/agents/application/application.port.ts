import type { AgentDocumentKind } from '../../../shared/database';

/**
 * AG-1: what the application ladder asks of modules that themselves depend on
 * `agents` — payouts (has the applicant given a bank account?), training (are
 * they certified?) and kyc (mirror the identity papers onto the desk's KYC
 * record). A direct import would be a cycle, so bootstrap registers these,
 * the way the lead layer and the review feed are registered.
 */
export interface ApplicationPort {
  /** True when the user has a payout method on file (pending verification counts: the desk verifies it at review). */
  hasPayoutMethod(userId: string): Promise<boolean>;
  /** The training certificate's state for the agent: CERTIFIED, LOCKED or REVOKED — and (AG-4) whether any lesson is published for them. */
  certificationState(userId: string): Promise<{ state: 'CERTIFIED' | 'LOCKED' | 'REVOKED'; available: boolean }>;
  /** AG-4: the screening assessment for the agent — the ASSESSMENT modules of their side, with the best attempt on each. */
  assessmentState(agentId: string): Promise<{ required: boolean; passed: boolean; modules: { id: string; title: string; passPercent: number; timeLimitMins: number | null; best: { score: number; total: number; passed: boolean; percent: number } | null }[] }>;
  /** The identity kinds an applicant filed, written onto the desk's KYC record so the queue sees them. */
  mirrorIdentityDocument(agentId: string, userId: string, kind: AgentDocumentKind, url: string, number: string | null): Promise<void>;
  /** Every ADMIN account — told when an application is submitted. */
  adminUserIds(): Promise<string[]>;
  /**
   * AG-5: the exit's settlement — the sessions ended, the live access grants
   * and the agent's QR codes revoked, the wallet's balance raised as the
   * closing withdrawal (the same door an account closure uses).
   */
  settleExit(agentId: string, userId: string): Promise<ExitSettlement>;
  /** AG-5: a stored file removed for good — the purge ninety days after an exit. False when nothing was there. */
  purgeFile(url: string): Promise<boolean>;
}

export type ExitSettlement = {
  sessionsEnded: boolean;
  grantsRevoked: number;
  qrDeactivated: boolean;
  /** The closing withdrawal, or null when the wallet held nothing. */
  payout: { amount: string; reference: string | null; outcome: string } | null;
  notes: string[];
};

let registered: ApplicationPort | null = null;

export function registerApplicationPort(port: ApplicationPort): void {
  registered = port;
}

/** Unregistered (tests, a partial bootstrap): nothing is on file and nothing is mirrored. */
export function applicationPort(): ApplicationPort {
  return (
    registered ?? {
      hasPayoutMethod: async () => false,
      certificationState: async () => ({ state: 'LOCKED', available: false }),
      assessmentState: async () => ({ required: false, passed: false, modules: [] }),
      mirrorIdentityDocument: async () => undefined,
      adminUserIds: async () => [],
      settleExit: async () => ({ sessionsEnded: false, grantsRevoked: 0, qrDeactivated: false, payout: null, notes: [] }),
      purgeFile: async () => false,
    }
  );
}
