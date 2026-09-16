import type { FraudSignal, PayoutHandle } from './types';

/** Below this penny-drop match the account is somebody else's. */
export const NAME_MATCH_FLOOR_PCT = 70;

const NOISE = ['mr', 'mrs', 'ms', 'dr', 'shri', 'smt', 'and', 'the', 'pvt', 'ltd', 'llp'];

const tokens = (value: string | null | undefined) =>
  (value ?? '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NOISE.includes(t));

/** Whether the account holder's name shares a word with the party's name — a surname, a company word. */
export function holderMatchesParty(holder: string | null | undefined, partyName: string | null | undefined): boolean {
  const a = tokens(holder);
  const b = tokens(partyName);
  if (a.length === 0 || b.length === 0) return true; // nothing to compare is not a mismatch
  return a.some((t) => b.includes(t));
}

/** One method's verdict: the rail's penny-drop figure when it stored one, else the holder name against the party's. */
export function methodMismatches(method: PayoutHandle, partyName: string | null): boolean {
  if (method.nameMatchPct !== null && method.nameMatchPct !== undefined) return method.nameMatchPct < NAME_MATCH_FLOOR_PCT;
  if (!method.accountHolder) return false;
  return !holderMatchesParty(method.accountHolder, partyName);
}

/** The payout account is in a name that is not the party's — the penny drop said so, or the holder name does. */
export const bankNameMismatchSignal: FraudSignal = {
  key: 'BANK_NAME_MISMATCH',
  weight: 0.2,
  async evaluate(subject, { index }) {
    if (!subject.userId) return { value: 0, detail: 'No login, so no payout method to compare.' };
    const methods = await index.payoutHandlesFor(subject.userId);
    if (methods.length === 0) return { value: 0, detail: 'No payout account on file.' };
    const mismatched = methods.filter((m) => methodMismatches(m, subject.name));
    if (mismatched.length === 0) return { value: 0, detail: 'Payout account holder matches the party name.' };
    const viaPennyDrop = mismatched.some((m) => m.nameMatchPct !== null && m.nameMatchPct !== undefined);
    return {
      value: 1,
      detail: viaPennyDrop
        ? `Penny-drop name match below ${NAME_MATCH_FLOOR_PCT}% on ${mismatched.length} payout ${mismatched.length === 1 ? 'method' : 'methods'}.`
        : `Account holder "${mismatched[0]?.accountHolder ?? ''}" does not match the party name "${subject.name ?? ''}".`,
    };
  },
};
