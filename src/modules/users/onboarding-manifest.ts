import type { OnboardingStepDef, OnboardingTemplate, OnboardingTile } from '../app-config';
import type { AccountType, LadderParty as Party } from './users.schema';

/**
 * The onboarding ladder, as data.
 *
 * DR 08 draws eleven steps for a publisher and numbers them; the settled
 * model runs the same ladder for an advertiser. Rather than two flows in
 * code, the app renders one ladder from this manifest, and the two personas
 * — and the three account types — differ only in what it says. The KYC
 * capture fields are the same names on both KYC rows for the same reason.
 *
 * Q83: the ladder is now composed from a **template** — `flows.onboarding`
 * on the AppConfig `main` row, edited by the console through
 * `PATCH /config/flows/onboarding` against the vocabulary in
 * `app-config/onboarding-template.ts`. `CODE_ONBOARDING_TEMPLATE` below is
 * the same ladder as code: it is what `scripts/seedConfig` writes, and what
 * the manifest falls back to when the row has no `onboarding` key or holds
 * one that fails the validator. The two produce a byte-identical manifest;
 * `__tests__/onboarding-manifest.test.ts` pins that.
 *
 * Why here and not in `onboarding`: that module is the admin's back-office
 * intake form over OnboardingFlowTemplate, and its seeded config uses field
 * kinds no phone renderer has. This is the phone's ladder; it answers for
 * the caller's own party, which `users` owns.
 *
 * Step 1 is the account type, already answered by the time this is read —
 * it is listed so "Step 6 of 11" on the frames stays true. An individual
 * has no business or contact-person step, so their ladder is ten.
 */

export type GovIdType = 'AADHAAR' | 'PASSPORT' | 'DRIVING_LICENCE';
export type AddressProofType = 'UTILITY_BILL' | 'RENT_AGREEMENT' | 'BANK_STATEMENT';

/**
 * One dashed tile on a capture step: the template's tile, plus what Lot D
 * (Q42) adds while the record is NEEDS_INFO — whether ops flagged it and
 * what they said. Only flagged tiles are drawn in partial mode.
 *
 * The template's tile properties: `field` is which KYC column the uploaded
 * file's URL goes to (`selfVideoUrl` is the liveness video on the UserKyc
 * row, Lot D Q131); `source` is where the photograph comes from (the selfie
 * must be the camera, front face); `sets` means choosing this tile also
 * answers a which-kind column; `inert` is a tile that takes no file — drawn,
 * not tappable, the way the Gov ID · Back step draws the passport ("Not
 * applicable — back not required", DR 08 4588:2645); `onlyWhen` draws the
 * tile only when the which-kind column already holds this value; `pdf` lets
 * the tile take a PDF through the OS document picker as well (Step 9's
 * address proofs, DR 08 4588:2739); `video` is a short clip rather than a
 * photograph.
 */
export type ManifestDocument = OnboardingTile & { flagged?: boolean; note?: string | null };

type StepOf<K extends OnboardingStepDef['kind']> = Extract<OnboardingStepDef, { kind: K }>;

export type ManifestStep =
  | StepOf<'account-type'>
  | StepOf<'form'>
  | StepOf<'kyc-intro'>
  | (Omit<StepOf<'capture'>, 'documents'> & { documents: ManifestDocument[] })
  | StepOf<'checklist'>
  | StepOf<'review'>
  | StepOf<'agreement'>;

/** Lot D: what the ladder knows about the record it is climbing towards. */
export interface ManifestKycContext {
  /** The record's status; absent before a first submission. */
  status?: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'NEEDS_INFO' | null;
  /** The reviewer's note on a NEEDS_INFO record. */
  reviewNote?: string | null;
  /** The flagged document columns with what was said about each. */
  flagged?: { field: string; note: string | null }[];
  /** Lot D (Q131): the liveness video's state, or null before one is recorded. */
  liveness?: { status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'NEEDS_INFO'; rejectionReason?: string | null } | null;
  /** Lot D (Q129): whether the Digio branch may be offered right now. */
  digio?: { available: boolean; provider: 'DIGIO' | 'DEGRADED' | 'MANUAL'; retryAfter: number | null };
}

export interface OnboardingManifest {
  party: Party;
  accountType: AccountType;
  /**
   * Lot D (Q42): `partial` is the NEEDS_INFO ladder — only the flagged
   * capture steps and the review step, so the party re-uploads exactly what
   * was asked for. `full` is the whole climb.
   */
  mode: 'full' | 'partial';
  /**
   * Q83: the template version this ladder was composed from. The phone
   * stamps it when the party takes the first step and asks for it again
   * (`?version=`) on every later read, so an edit in the console does not
   * move the rungs under someone mid-climb.
   */
  manifestVersion: number;
  verification: {
    /** The Digio branch, and why it is off when it is. */
    digio: { available: boolean; provider: 'DIGIO' | 'DEGRADED' | 'MANUAL'; retryAfter: number | null };
    /** The manual branch needs the liveness video before the desk can verify (Q131). */
    liveness: { required: true; status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'NEEDS_INFO' | null };
    kycStatus: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'NEEDS_INFO' | null;
    reviewNote: string | null;
  };
  steps: ManifestStep[];
}

/* ── The code ladder, as a template ──────────────────────────────────── */

const KYC_STEPS: Record<string, OnboardingStepDef> = {
  'kyc-intro': {
    key: 'kyc-intro',
    kind: 'kyc-intro',
    title: 'Verify your identity',
    subtitle: 'Five quick uploads. Encrypted, used only for verification.',
    bands: [
      { label: 'Identity', value: 'Aadhaar · Passport · DL' },
      { label: 'Tax', value: 'PAN card' },
      { label: 'Address', value: 'Utility bill · Rent agreement' },
      { label: 'Match', value: 'Live selfie' },
    ],
    cta: 'Start verification',
  },
  'gov-id-front': {
    key: 'gov-id-front',
    kind: 'capture',
    title: 'Government ID · Front',
    subtitle: 'Aadhaar, passport, or driving licence. Clear photo, no glare.',
    documents: [
      {
        key: 'aadhaar',
        label: 'Aadhaar card',
        hint: 'Front face with 12-digit number visible',
        field: 'govIdFrontUrl',
        source: 'library',
        sets: { field: 'govIdType', value: 'AADHAAR' },
      },
      {
        key: 'passport',
        label: 'Passport',
        hint: 'Bio-page. Non-expired.',
        field: 'govIdFrontUrl',
        source: 'library',
        sets: { field: 'govIdType', value: 'PASSPORT' },
      },
      {
        key: 'driving-licence',
        label: 'Driving licence',
        hint: 'Both sides. Non-expired.',
        field: 'govIdFrontUrl',
        source: 'library',
        sets: { field: 'govIdType', value: 'DRIVING_LICENCE' },
      },
    ],
    cta: 'Use this photo',
  },
  'gov-id-back': {
    key: 'gov-id-back',
    kind: 'capture',
    title: 'Government ID · Back',
    subtitle: 'The reverse of the same document. Address side, all corners visible.',
    // Three tiles mirroring the front, as the frame draws them; the one the
    // agent chose on the front is the one shown, and a passport's is inert
    // because a passport has no back to photograph — the step is skippable.
    documents: [
      {
        key: 'aadhaar-back',
        label: 'Aadhaar card',
        hint: 'Back face with the address',
        field: 'govIdBackUrl',
        source: 'library',
        onlyWhen: { field: 'govIdType', value: 'AADHAAR' },
      },
      {
        key: 'passport-back',
        label: 'Passport',
        hint: 'Not applicable — back not required',
        field: 'govIdBackUrl',
        source: 'library',
        inert: true,
        onlyWhen: { field: 'govIdType', value: 'PASSPORT' },
      },
      {
        key: 'driving-licence-back',
        label: 'Driving licence',
        hint: 'Back face, all corners visible',
        field: 'govIdBackUrl',
        source: 'library',
        onlyWhen: { field: 'govIdType', value: 'DRIVING_LICENCE' },
      },
    ],
    skippableWhen: { field: 'govIdType', value: 'PASSPORT' },
    cta: 'Use this photo',
  },
  pan: {
    key: 'pan',
    kind: 'capture',
    title: 'PAN card',
    subtitle: 'Photo of your PAN card. All four corners visible.',
    text: {
      field: 'panNumber',
      label: 'PAN number',
      hint: '10-character alphanumeric',
      pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$',
      maxLength: 10,
    },
    documents: [
      {
        key: 'pan-photo',
        label: 'Photograph',
        hint: 'Clear and non-obscured',
        field: 'panFrontUrl',
        source: 'library',
      },
      {
        key: 'pan-signature',
        label: 'Signature',
        hint: 'Bottom-right, matching your signed documents',
        field: 'panSignatureUrl',
        source: 'library',
      },
    ],
    cta: 'Use this photo',
  },
  'address-proof': {
    key: 'address-proof',
    kind: 'capture',
    title: 'Address proof',
    subtitle: 'A document showing your current address. Issued in the last three months.',
    documents: [
      {
        key: 'utility-bill',
        label: 'Utility bill',
        hint: 'Electricity, water or gas, in your name',
        field: 'addressProofUrl',
        source: 'library',
        pdf: true,
        sets: { field: 'addressProofType', value: 'UTILITY_BILL' },
      },
      {
        key: 'rent-agreement',
        label: 'Rent agreement',
        hint: 'Registered, with your name and the address',
        field: 'addressProofUrl',
        source: 'library',
        pdf: true,
        sets: { field: 'addressProofType', value: 'RENT_AGREEMENT' },
      },
      {
        key: 'bank-statement',
        label: 'Bank statement',
        hint: 'First page, with the address',
        field: 'addressProofUrl',
        source: 'library',
        pdf: true,
        sets: { field: 'addressProofType', value: 'BANK_STATEMENT' },
      },
    ],
    cta: 'Upload document',
  },
  selfie: {
    key: 'selfie',
    kind: 'capture',
    title: 'Selfie verification',
    subtitle: 'A quick selfie so we can match your ID to you.',
    guidance: [
      { label: 'Position', hint: 'Face centered, both eyes clearly visible' },
      { label: 'Lighting', hint: 'Bright, no shadows or filters' },
      { label: 'Match', hint: 'We compare it with your Government ID photo' },
    ],
    documents: [
      {
        key: 'selfie',
        label: 'Your selfie',
        hint: 'Taken now, with the front camera',
        field: 'selfieUrl',
        source: 'camera',
        front: true,
      },
    ],
    cta: 'Take selfie',
  },
  liveness: {
    // Lot D (Q131): the liveness proof on the manual branch. Digio performs
    // its own, so the Digio branch never draws this step.
    key: 'liveness',
    kind: 'capture',
    title: 'Record a short video',
    subtitle: 'A five-second clip of you, so we know the person behind the documents is here.',
    guidance: [
      { label: 'Face', hint: 'Look at the camera, face centred' },
      { label: 'Say', hint: 'Say your name and the date' },
      { label: 'Length', hint: 'Five seconds is enough' },
    ],
    documents: [
      {
        key: 'liveness-video',
        label: 'Your video',
        hint: 'Recorded now, with the front camera',
        field: 'selfVideoUrl',
        source: 'camera',
        front: true,
        video: true,
      },
    ],
    cta: 'Record video',
  },
  checklist: {
    key: 'checklist',
    kind: 'checklist',
    title: 'Review your KYC',
    subtitle: 'Check everything before submitting. You can retake any document.',
    cta: 'Submit for review',
  },
};

const KYC_LADDER = ['kyc-intro', 'gov-id-front', 'gov-id-back', 'pan', 'address-proof', 'selfie', 'liveness', 'checklist'];

/**
 * The ladder as `scripts/seedConfig` writes it and as the manifest falls
 * back to. Six ladders over one library of steps: the details step differs
 * by party (the noun), the business step by account type (business or
 * organisation), and the KYC climb is the same eight for everyone.
 */
export const CODE_ONBOARDING_TEMPLATE: OnboardingTemplate = {
  label: 'Onboarding',
  version: 1,
  steps: {
    'account-type': { key: 'account-type', kind: 'account-type', title: 'Account type' },
    'publisher-details': {
      key: 'details',
      kind: 'form',
      title: 'Publisher details',
      subtitle: 'Legal name, PAN, and GSTIN as printed on your documents',
    },
    'advertiser-details': {
      key: 'details',
      kind: 'form',
      title: 'Advertiser details',
      subtitle: 'Legal name, PAN, and GSTIN as printed on your documents',
    },
    business: {
      key: 'business',
      kind: 'form',
      title: 'Business information',
      subtitle: 'Registered name, GSTIN and where it is',
    },
    organisation: {
      key: 'business',
      kind: 'form',
      title: 'Organisation information',
      subtitle: 'Registered name, GSTIN and where it is',
    },
    contact: {
      key: 'contact',
      kind: 'form',
      title: 'Contact person',
      subtitle: 'Who ADX should reach about this account',
    },
    ...KYC_STEPS,
  },
  ladders: {
    PUBLISHER: {
      INDIVIDUAL: ['account-type', 'publisher-details', ...KYC_LADDER],
      BUSINESS: ['account-type', 'publisher-details', 'business', 'contact', ...KYC_LADDER],
      ORGANISATION: ['account-type', 'publisher-details', 'organisation', 'contact', ...KYC_LADDER],
    },
    ADVERTISER: {
      INDIVIDUAL: ['account-type', 'advertiser-details', ...KYC_LADDER],
      BUSINESS: ['account-type', 'advertiser-details', 'business', 'contact', ...KYC_LADDER],
      ORGANISATION: ['account-type', 'advertiser-details', 'organisation', 'contact', ...KYC_LADDER],
    },
  },
};

/* ── Composition ─────────────────────────────────────────────────────── */

const DIGIO_DEFAULT = { available: true, provider: 'DIGIO' as const, retryAfter: null };

/** The ladder's steps in order; an id the library lacks is skipped (the validator refuses such a template before it is stored). */
function ladderSteps(template: OnboardingTemplate, party: Party, accountType: AccountType): OnboardingStepDef[] {
  const ids = template.ladders[party]?.[accountType] ?? [];
  return ids.map((id) => template.steps[id]).filter((step): step is OnboardingStepDef => step !== undefined);
}

/**
 * The NEEDS_INFO ladder: the capture steps holding a flagged tile, each tile
 * marked with the reviewer's note, and the review step. A rejected liveness
 * video brings the video step back the same way.
 */
function partialSteps(ladder: OnboardingStepDef[], context: ManifestKycContext): ManifestStep[] {
  const flagged = new Map((context.flagged ?? []).map((item) => [item.field, item.note ?? context.reviewNote ?? null]));
  const steps: ManifestStep[] = [];
  for (const step of ladder) {
    if (step.kind !== 'capture') continue;
    const videoRejected = context.liveness?.status === 'REJECTED' && step.documents.some((doc) => doc.field === 'selfVideoUrl');
    const hasFlag = step.documents.some((doc) => flagged.has(doc.field));
    if (!hasFlag && !videoRejected) continue;
    steps.push({
      ...step,
      documents: step.documents.map((doc) =>
        flagged.has(doc.field) || (videoRejected && doc.field === 'selfVideoUrl')
          ? { ...doc, flagged: true, note: videoRejected && doc.field === 'selfVideoUrl' ? (context.liveness?.rejectionReason ?? null) : (flagged.get(doc.field) ?? null) }
          : doc,
      ),
    });
  }
  // The last summary step on the ladder — checklist or review — retitled for the resubmission.
  const review = [...ladder].reverse().find((step) => step.kind === 'checklist' || step.kind === 'review');
  if (review) {
    steps.push({
      ...review,
      title: 'Send the flagged documents again',
      subtitle: context.reviewNote ?? 'Only the flagged documents are needed; everything else is kept.',
      cta: 'Resubmit for review',
    });
  }
  return steps;
}

export function buildOnboardingManifest(
  party: Party,
  accountType: AccountType,
  context: ManifestKycContext = {},
  template: OnboardingTemplate = CODE_ONBOARDING_TEMPLATE,
): OnboardingManifest {
  const manifestVersion = template.version ?? 1;
  const verification: OnboardingManifest['verification'] = {
    digio: context.digio ?? DIGIO_DEFAULT,
    liveness: { required: true, status: context.liveness?.status ?? null },
    kycStatus: context.status ?? null,
    reviewNote: context.reviewNote ?? null,
  };
  const ladder = ladderSteps(template, party, accountType);
  if (context.status === 'NEEDS_INFO') {
    return { party, accountType, mode: 'partial', manifestVersion, verification, steps: partialSteps(ladder, context) };
  }
  return { party, accountType, mode: 'full', manifestVersion, verification, steps: ladder as ManifestStep[] };
}
