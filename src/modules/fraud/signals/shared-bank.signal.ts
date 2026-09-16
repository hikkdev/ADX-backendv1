import type { FraudSignal, PayoutHandle } from './types';

export const normaliseAccount = (value: string | null | undefined) => (value ?? '').replace(/[\s-]/g, '').toUpperCase();
export const normaliseUpi = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

export function handlesOf(methods: PayoutHandle[]): { accountNumbers: string[]; upiVpas: string[] } {
  return {
    accountNumbers: [...new Set(methods.map((m) => normaliseAccount(m.accountNumber)).filter(Boolean))],
    upiVpas: [...new Set(methods.map((m) => normaliseUpi(m.upiVpa)).filter(Boolean))],
  };
}

/** The same payout account number or UPI id on more than one party — the money goes to one place. */
export const sharedBankSignal: FraudSignal = {
  key: 'SHARED_BANK',
  weight: 0.35,
  async evaluate(subject, { index }) {
    if (!subject.userId) return { value: 0, detail: 'No login, so no payout method to compare.' };
    const handles = handlesOf(await index.payoutHandlesFor(subject.userId));
    if (handles.accountNumbers.length === 0 && handles.upiVpas.length === 0) {
      return { value: 0, detail: 'No payout account on file.' };
    }
    const links = await index.partiesWithPayoutHandle(handles, subject);
    if (links.length === 0) return { value: 0, detail: 'Payout account is not on any other party.' };
    return {
      value: 1,
      detail: `Payout account shared with ${links.length} other ${links.length === 1 ? 'party' : 'parties'}: ${links.map((l) => `${l.type} ${l.name ?? l.id}`).join(', ')}.`,
      links,
    };
  },
};
