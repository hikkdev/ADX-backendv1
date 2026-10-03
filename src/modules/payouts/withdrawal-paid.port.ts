import type { WithdrawalRow } from './payouts.repository';

/**
 * Account lifecycle (2 Oct 2026): what else happens when a withdrawal is
 * PAID. An exited agent keeps signing in until their final payout lands, and
 * `agents` (which this module sits underneath) ends it — so the question is a
 * port bootstrap fills. Best effort: a hook that fails never unwinds a payment.
 */
export type WithdrawalPaidPort = {
  onPaid(paid: WithdrawalRow, byUserId: string): Promise<void>;
};

let registered: WithdrawalPaidPort | null = null;

export function registerWithdrawalPaidPort(port: WithdrawalPaidPort | null): void {
  registered = port;
}

export function withdrawalPaidPort(): WithdrawalPaidPort | null {
  return registered;
}
