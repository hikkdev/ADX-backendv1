import type { FraudSignal } from './types';

/** The same mobile number registered as a party of another type — a publisher who is also the advertiser booking them. */
export const sharedPhoneAcrossRolesSignal: FraudSignal = {
  key: 'SHARED_PHONE_ACROSS_ROLES',
  weight: 0.15,
  async evaluate(subject, { index }) {
    if (!subject.mobile) return { value: 0, detail: 'No mobile number on the party.' };
    const links = (await index.partiesWithMobile(subject.mobile, subject)).filter((l) => l.type !== subject.type);
    if (links.length === 0) return { value: 0, detail: 'Mobile number is held by no party of another type.' };
    return {
      value: 1,
      detail: `Mobile number also registered as ${links.map((l) => `${l.type} ${l.name ?? l.id}`).join(', ')}.`,
      links,
    };
  },
};
