import { handlesOf } from './shared-bank.signal';
import type { FraudSignal, LinkedParty } from './types';

/** A publisher and an advertiser with the same PAN or the same bank account — booking oneself to farm earnings or credits. */
export const selfDealingSignal: FraudSignal = {
  key: 'SELF_DEALING',
  weight: 0.4,
  async evaluate(subject, { index }) {
    if (subject.type === 'AGENT') return { value: 0, detail: 'An agent neither lists nor books.' };
    const opposite = subject.type === 'PUBLISHER' ? 'ADVERTISER' : 'PUBLISHER';
    const linked = new Map<string, LinkedParty & { via: string[] }>();
    const add = (parties: LinkedParty[], via: string) => {
      for (const p of parties) {
        if (p.type !== opposite) continue;
        const key = `${p.type}:${p.id}`;
        const entry = linked.get(key) ?? { ...p, via: [] };
        entry.via.push(via);
        linked.set(key, entry);
      }
    };
    if (subject.pan) add(await index.partiesWithPan(subject.pan, subject), 'PAN');
    if (subject.userId) {
      const handles = handlesOf(await index.payoutHandlesFor(subject.userId));
      if (handles.accountNumbers.length || handles.upiVpas.length) add(await index.partiesWithPayoutHandle(handles, subject), 'bank');
    }
    if (linked.size === 0) return { value: 0, detail: `No ${opposite.toLowerCase()} shares this party's PAN or bank account.` };
    const links = [...linked.values()];
    return {
      value: 1,
      detail: `Same person on both sides: ${links.map((l) => `${l.type} ${l.name ?? l.id} (${l.via.join(', ')})`).join('; ')}.`,
      links: links.map(({ type, id, name }) => ({ type, id, name })),
    };
  },
};
