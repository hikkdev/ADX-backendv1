import type { FraudSignal } from './types';

export const SIGN_IN_WINDOW_DAYS = 30;

/** The /24 an IPv4 address sits in; an IPv6 address keeps its first four hextets. Null for anything unparseable. */
export function subnetOf(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.trim().replace(/^::ffff:/i, '');
  const parts = v4.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  if (v4.includes(':')) return `${v4.split(':').slice(0, 4).join(':')}::/64`;
  return null;
}

/** Sign-ins from the same /24 as another party inside thirty days — the same office, house or phone. Circumstantial, so light. */
export const sharedIpSubnetSignal: FraudSignal = {
  key: 'SHARED_IP_SUBNET',
  weight: 0.15,
  async evaluate(subject, { index, now }) {
    if (!subject.userId) return { value: 0, detail: 'No login, so no sign-ins to compare.' };
    const since = new Date(now.getTime() - SIGN_IN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const subnets = await index.signInSubnetsFor(subject.userId, since);
    if (subnets.length === 0) return { value: 0, detail: `No sign-ins with an address in the last ${SIGN_IN_WINDOW_DAYS} days.` };
    const links = await index.partiesOnSubnets(subnets, since, subject);
    if (links.length === 0) return { value: 0, detail: `No other party signed in from the same /24 in ${SIGN_IN_WINDOW_DAYS} days.` };
    return {
      value: 1,
      detail: `Signed in from the same /24 as ${links.length} other ${links.length === 1 ? 'party' : 'parties'} in ${SIGN_IN_WINDOW_DAYS} days.`,
      links,
    };
  },
};
