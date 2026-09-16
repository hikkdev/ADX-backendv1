import type { LegalDocument, LegalDocumentKind } from '../../shared/database';

export type { LegalDocument, LegalDocumentKind };

/** The ten DR 07 policies, plus the three read documents the same screens need. */
export const LEGAL_KINDS = [
  'PRIVACY_POLICY',
  'TERMS_OF_SERVICE',
  'REFUND_POLICY',
  'CONTENT_POLICY',
  'COMMUNITY_GUIDELINES',
  'COMMISSION_STRUCTURE',
  'CODE_OF_CONDUCT',
  'LEGAL_DISCLAIMER',
  'CONTACT_INFO',
  'ABOUT',
  'FAQ',
  'SAFETY_GUIDELINES',
  'OPEN_SOURCE_LICENSES',
] as const;

/** What the About & Policies index prints under each title (Figma 4413:13331). */
export const KIND_META: Record<LegalDocumentKind, { label: string; blurb: string; structured: boolean }> = {
  PRIVACY_POLICY: { label: 'Privacy policy', blurb: 'How we collect and use your data', structured: false },
  TERMS_OF_SERVICE: { label: 'Terms of service', blurb: 'User agreement and platform rules', structured: false },
  REFUND_POLICY: { label: 'Refund policy', blurb: 'When money comes back, and how', structured: false },
  CONTENT_POLICY: { label: 'Content policy', blurb: 'What may be advertised, and where', structured: false },
  COMMUNITY_GUIDELINES: { label: 'Community guidelines', blurb: 'Professional conduct expectations', structured: false },
  COMMISSION_STRUCTURE: { label: 'Commission structure', blurb: 'Earnings methodology and payment terms', structured: false },
  CODE_OF_CONDUCT: { label: 'Code of conduct', blurb: 'Integrity and dispute resolution', structured: false },
  LEGAL_DISCLAIMER: { label: 'Legal disclaimer', blurb: 'Limits of liability and of advice', structured: false },
  /** `meta` carries the office, lines, email and registration the Contact frames draw. */
  CONTACT_INFO: { label: 'Contact info', blurb: 'Office, support line and email', structured: true },
  ABOUT: { label: 'About ADX', blurb: 'Who runs the platform', structured: false },
  /** `meta.items` carries the questions and answers the FAQs accordion draws. */
  FAQ: { label: 'FAQs', blurb: 'Common questions, answered', structured: true },
  SAFETY_GUIDELINES: { label: 'Safety guidelines', blurb: 'Working at height, electrical, traffic', structured: false },
  OPEN_SOURCE_LICENSES: { label: 'Open source licenses', blurb: 'The software this app is built on', structured: false },
};

export type DocumentState = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';

export type NewDocument = {
  kind: LegalDocumentKind;
  version: number;
  title: string;
  summary: string | null;
  body: string;
  meta: unknown;
  changeNote: string | null;
  createdByUserId: string | null;
};

export type DocumentPatch = {
  title?: string;
  summary?: string | null;
  body?: string;
  meta?: unknown;
  changeNote?: string | null;
};

/** One published document as the apps read it. */
export type PublicDocument = {
  kind: LegalDocumentKind;
  label: string;
  blurb: string;
  title: string;
  summary: string | null;
  version: number;
  effectiveFrom: Date;
  body: string;
  meta: unknown;
};

/** The index: every kind with a live version, without bodies. */
export type PublicIndexEntry = Omit<PublicDocument, 'body' | 'meta'>;
