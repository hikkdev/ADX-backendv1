import { z } from 'zod';

/**
 * DS-1 (Digio eSign, 22 Sep 2026): what ops decide about e-signing — which
 * of the five documents are signed rather than clicked, how, and when. The
 * shape lives here because `app-config` validates it as a platform-settings
 * section and `agreements` consumes it, and neither may import the other
 * (`app-config` reaches `users`, which reaches `agreements`).
 *
 * The five documents (the owner, 21 Sep 2026):
 *
 * | Document               | Agreement kind(s)                                   | When it is opened                        | What it gates                                  |
 * | ---------------------- | --------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
 * | AGENT_ENGAGEMENT       | AGENT_PUBLISHER_PLATFORM / AGENT_ADVERTISER_PLATFORM | the desk activates the agent             | working (the dashboard, accepting an order)    |
 * | EMPLOYEE_APPOINTMENT   | EMPLOYEE_APPOINTMENT                                | Employees › New                          | the console invitation                         |
 * | PRINT_PARTNER_SERVICE  | PRINT_PARTNER_SERVICE                               | the partner's KYC verifies               | quoting and accepting jobs                     |
 * | PUBLISHER_LICENCE      | PUBLISHER_LICENCE                                   | the first listing is approved (or submitted) | publishing the next attempt                |
 * | INSERTION_ORDER        | INSERTION_ORDER                                     | checkout, above the threshold or band    | authorising that campaign                      |
 *
 * `enabled` off — the default — leaves every gate exactly as it was: the
 * click acceptances stand and nothing is sent to Digio.
 */
export const SIGNING_DOCUMENTS = ['AGENT_ENGAGEMENT', 'EMPLOYEE_APPOINTMENT', 'PRINT_PARTNER_SERVICE', 'PUBLISHER_LICENCE', 'INSERTION_ORDER'] as const;
export type SigningDocument = (typeof SIGNING_DOCUMENTS)[number];

export const SIGN_METHODS = ['AADHAAR', 'DSC', 'ELECTRONIC'] as const;
export type SignMethodName = (typeof SIGN_METHODS)[number];

export const PARTY_BANDS = ['INDIVIDUAL', 'SMALL_AGENCY', 'LARGE_AGENCY'] as const;

/** DS-4: one line of the stamp-duty table — a lawyer's figure per document and state. */
export const stampDutySchema = z.object({
  document: z.enum(SIGNING_DOCUMENTS),
  /** ISO 3166-2 code without the country: KA, MH, DL … */
  state: z.string().trim().toUpperCase().length(2),
  amount: z.number().min(0).max(1_000_000),
  article: z.string().trim().max(40).optional(),
});
export type StampDuty = z.infer<typeof stampDutySchema>;

export const esignPolicySchema = z.object({
  /** The master switch. Off, every document keeps its click. */
  enabled: z.boolean(),
  /** Decision 3: Aadhaar OTP by default; DSC for the company signatories that insist. */
  signMethod: z.enum(SIGN_METHODS),
  /** How long a signing link lives. */
  expireInDays: z.number().int().min(1).max(90),
  /** DS-4: ADX countersigns with its Document Signer Certificate, after the party. */
  countersign: z.boolean(),
  /** Digio sends each signer the link itself, beside ADX's own message. */
  notifyThroughDigio: z.boolean(),
  /** Which documents are signed rather than clicked, while `enabled`. */
  documents: z.record(z.enum(SIGNING_DOCUMENTS), z.boolean()),
  /** Decision 5: an insertion order is signed when the campaign total reaches the threshold, or the advertiser's band is listed. */
  insertionOrder: z.object({
    valueThreshold: z.number().min(0),
    bands: z.array(z.enum(PARTY_BANDS)),
  }),
  /** Decision 6: when the publisher's master licence is asked for. */
  publisherLicenceAt: z.enum(['FIRST_APPROVED_LISTING', 'FIRST_SUBMISSION']),
  /** Decision 7: a new live version asks the party to sign again before the next gated act. */
  resignOnNewVersion: z.boolean(),
  /** DS-4: the stamp-duty table; empty means no e-stamp on that document in that state. */
  stampDuty: z.array(stampDutySchema).max(200),
});

export type EsignPolicy = z.infer<typeof esignPolicySchema>;

export const DEFAULT_ESIGN_POLICY: EsignPolicy = {
  enabled: false,
  signMethod: 'AADHAAR',
  expireInDays: 15,
  countersign: false,
  notifyThroughDigio: true,
  documents: {
    AGENT_ENGAGEMENT: true,
    EMPLOYEE_APPOINTMENT: true,
    PRINT_PARTNER_SERVICE: true,
    PUBLISHER_LICENCE: true,
    INSERTION_ORDER: true,
  },
  insertionOrder: { valueThreshold: 100_000, bands: ['LARGE_AGENCY'] },
  publisherLicenceAt: 'FIRST_APPROVED_LISTING',
  resignOnNewVersion: false,
  stampDuty: [],
};
