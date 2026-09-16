import type { FraudSignal } from './types';

/**
 * The same push token registered by more than one login. The token is the
 * only device identity the platform holds today (`DeviceToken.token`) — an
 * app-side device id (a stable install id the phone reports at sign-in) is
 * a later addition, and until it lands this signal sees only what the token
 * table shows: a token is unique per row, so a phone that re-registers under
 * a second account moves the row rather than duplicating it, and the
 * signal reads 0. It is kept in the table so the weight and the read are
 * already in place for the id column.
 */
export const sharedDeviceSignal: FraudSignal = {
  key: 'SHARED_DEVICE',
  weight: 0.25,
  async evaluate(subject, { index }) {
    if (!subject.userId) return { value: 0, detail: 'No login, so no device to compare.' };
    const tokens = await index.deviceTokensFor(subject.userId);
    if (tokens.length === 0) return { value: 0, detail: 'No device registered to the login.' };
    const links = await index.partiesWithDeviceTokens(tokens, subject);
    if (links.length === 0) return { value: 0, detail: 'No other party registered the same device (push token; the app-side device id is a later addition).' };
    return {
      value: 1,
      detail: `Device shared with ${links.map((l) => `${l.type} ${l.name ?? l.id}`).join(', ')}.`,
      links,
    };
  },
};
