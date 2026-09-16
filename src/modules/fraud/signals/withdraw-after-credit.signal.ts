import type { CreditEvent, FraudSignal, WithdrawalEvent } from './types';

export const WITHDRAW_WITHIN_MS = 60 * 60 * 1000;
export const REPEATS_FOR_FULL = 3;
export const MOVEMENT_WINDOW_DAYS = 90;

/** How many credits were followed by a withdrawal request inside the hour. Each withdrawal is counted once. */
export function quickWithdrawals(credits: CreditEvent[], withdrawals: WithdrawalEvent[]): number {
  const pending = [...withdrawals].sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  let count = 0;
  for (const credit of [...credits].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const idx = pending.findIndex((w) => {
      const gap = w.requestedAt.getTime() - credit.at.getTime();
      return gap >= 0 && gap <= WITHDRAW_WITHIN_MS;
    });
    if (idx >= 0) {
      count += 1;
      pending.splice(idx, 1);
    }
  }
  return count;
}

/** Money pulled out within the hour of landing, again and again — a wallet used as a pass-through. */
export const withdrawAfterCreditSignal: FraudSignal = {
  key: 'WITHDRAW_AFTER_CREDIT',
  weight: 0.2,
  async evaluate(subject, { index, now }) {
    const since = new Date(now.getTime() - MOVEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const { credits, withdrawals } = await index.walletMovementsFor(subject, since);
    if (credits.length === 0 || withdrawals.length === 0) return { value: 0, detail: 'No credit followed by a withdrawal in the window.' };
    const quick = quickWithdrawals(credits, withdrawals);
    if (quick === 0) return { value: 0, detail: `${withdrawals.length} withdrawals, none within an hour of a credit.` };
    return {
      value: Math.min(1, Math.round((quick / REPEATS_FOR_FULL) * 1000) / 1000),
      detail: `${quick} ${quick === 1 ? 'withdrawal' : 'withdrawals'} requested within an hour of a credit in ${MOVEMENT_WINDOW_DAYS} days.`,
    };
  },
};
