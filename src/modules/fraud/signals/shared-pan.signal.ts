import type { FraudSignal } from './types';

/** The same PAN on more than one party's KYC row — one person behind several accounts. */
export const sharedPanSignal: FraudSignal = {
  key: 'SHARED_PAN',
  weight: 0.35,
  async evaluate(subject, { index }) {
    if (!subject.pan) return { value: 0, detail: 'No PAN on the KYC record to compare.' };
    const links = await index.partiesWithPan(subject.pan, subject);
    if (links.length === 0) return { value: 0, detail: 'PAN is not on any other party.' };
    return {
      value: 1,
      detail: `PAN shared with ${links.length} other ${links.length === 1 ? 'party' : 'parties'}: ${links.map((l) => `${l.type} ${l.name ?? l.id}`).join(', ')}.`,
      links,
    };
  },
};
