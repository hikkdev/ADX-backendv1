import type { SmsRail } from '../rail';

/**
 * The seam for a third operator — Lot E (Q128).
 *
 * Not configured, never sends, reads no reports. It exists so the credentials
 * row can already name `third` in a fallback list and so the next adapter is
 * a matter of filling in this file rather than touching the chooser. When it
 * arrives, `describe()` reads its own keys from the integrations row and the
 * two methods do what msg91.ts and twilio.ts do for theirs.
 */
export const thirdRail: SmsRail = {
  name: 'third',

  async describe() {
    return { configured: false };
  },

  async send() {
    throw new Error('The third SMS rail is not configured');
  },

  async parseDeliveryWebhook() {
    return [];
  },
};
