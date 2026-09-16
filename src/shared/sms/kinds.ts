/**
 * The vocabulary of every SMS ADX sends — Lot E (Q128).
 *
 * Imports nothing on purpose: `shared/integrations` reads these names to type
 * the SMS section of the credentials row, and `shared/sms` reads that section
 * to pick a rail, so the names have to sit underneath both.
 *
 * A kind is a DLT-registered message, not a free-text body. TRAI's DLT rules
 * mean an Indian operator will only pass a message whose content matches a
 * template registered against ADX's entity id, so every send names one of
 * these and the rail looks up its own template id for it. A kind nobody has
 * registered on the rail in use is logged and skipped rather than sent —
 * a message that would be rejected anyway, and a bill for the attempt.
 */
export const SMS_KINDS = [
  'LOGIN_OTP',
  'TWO_FACTOR',
  'ORDER_OTP',
  'PACKAGE_LINK',
  'VISIT_OFFER',
  'KYC_DECISION',
  /** Lot N: the desk asked the party for their KYC — `kyc-requested` template, KYC_REQUESTED event. */
  'KYC_REQUESTED',
  'PAYOUT_PAID',
  'ANNOUNCEMENT_CRITICAL',
  'INVITE',
  /** E9: the old number is told the sign-in number moved — `mobile-changed` template, MOBILE_CHANGED event. */
  'CHANGE_MOBILE',
] as const;

export type SmsKind = (typeof SMS_KINDS)[number];

export const isSmsKind = (value: unknown): value is SmsKind =>
  typeof value === 'string' && (SMS_KINDS as readonly string[]).includes(value);

/** MSG91 and Twilio are wired; `third` is the seam for the next operator. */
export const SMS_RAIL_NAMES = ['msg91', 'twilio', 'third'] as const;
export type SmsRailName = (typeof SMS_RAIL_NAMES)[number];

export const isSmsRailName = (value: unknown): value is SmsRailName =>
  typeof value === 'string' && (SMS_RAIL_NAMES as readonly string[]).includes(value);

/**
 * One kind's registration on one rail.
 *
 * `templateId` is the rail's own id for the DLT template (MSG91's flow id,
 * Twilio's content/DLT template id). `vars` names the variables the template
 * takes, in the order it takes them, so a rail that posts named variables
 * sends exactly those and nothing else. `body` is the registered text with
 * `{{name}}` placeholders — a rail that has to post the rendered text (Twilio)
 * renders it from here, so the words on the wire are the words on the
 * registration.
 */
export interface SmsKindRegistration {
  templateId: string;
  vars?: string[];
  body?: string;
}

export type SmsRailTemplates = Partial<Record<SmsKind, SmsKindRegistration>>;
