import { describe, expect, it } from 'vitest';
import {
  ADVERTISER_MIN_EDUCATION,
  ageOn,
  decisionAllowed,
  documentsView,
  exitAllowed,
  hashDocumentNumber,
  ladderOf,
  maskDocumentNumber,
  meetsEducationFloor,
  profileGaps,
  requiredDocuments,
  stageForUnsubmitted,
  withdrawalAllowed,
  type ProfileFacts, screeningOf, stageForSubmitted, activationGaps } from '../application/application.rules';
import { kindsForKycSlots } from '../application/kyc-bridge';

/**
 * AG-1 (the owner, 20 Sep 2026): the agent application's rules, pinned.
 *
 * Two intakes on one ladder. The publisher agent is a delivery-partner
 * profile: identity, vehicle papers when they ride, bank, no interview. The
 * advertiser agent is a sales-executive profile: 12th pass at least, an
 * education certificate and a résumé, a reference. Nothing offers work below
 * ACTIVE, and the desk's moves are open only from the stages that make sense.
 */

const NOW = new Date('2026-09-20T12:00:00Z');

const facts = (over: Partial<ProfileFacts> = {}): ProfileFacts => ({
  name: 'Rahul Menon',
  dateOfBirth: new Date('1996-03-04'),
  gender: 'MALE',
  city: 'Bengaluru',
  languages: ['Kannada', 'English'],
  vehicleType: 'SCOOTER',
  currentAddress: '12, 4th Cross, Koramangala',
  permanentAddress: 'Kochi',
  emergencyContactName: 'Priya',
  emergencyContactPhone: '+919000000009',
  highestEducation: 'GRADUATE',
  salesExperienceYears: 2,
  referenceCount: 2,
  ...over,
});

describe('what each side must file', () => {
  it('a publisher agent on a motor vehicle files the identity set and the vehicle papers', () => {
    expect(requiredDocuments('PUBLISHER', 'SCOOTER')).toEqual([
      'AADHAAR_FRONT', 'AADHAAR_BACK', 'PAN', 'SELFIE', 'ADDRESS_PROOF', 'BANK_PROOF',
      'DRIVING_LICENCE_FRONT', 'DRIVING_LICENCE_BACK', 'VEHICLE_RC', 'VEHICLE_INSURANCE',
    ]);
  });

  it('on a bicycle or on foot the vehicle papers are not asked for (decision 3)', () => {
    expect(requiredDocuments('PUBLISHER', 'BICYCLE')).not.toContain('DRIVING_LICENCE_FRONT');
    expect(requiredDocuments('PUBLISHER', 'NONE')).toHaveLength(6);
  });

  it('an advertiser agent files the identity set, an education certificate and a résumé; no vehicle papers', () => {
    const kinds = requiredDocuments('ADVERTISER', 'CAR');
    expect(kinds).toContain('EDUCATION_CERTIFICATE');
    expect(kinds).toContain('RESUME');
    expect(kinds).not.toContain('VEHICLE_RC');
  });
});

describe('the profile step', () => {
  it('is complete for a publisher agent with the basics and a vehicle', () => {
    expect(profileGaps('PUBLISHER', facts(), NOW)).toEqual([]);
  });

  it('names what is missing, in the words the app prints', () => {
    expect(profileGaps('PUBLISHER', facts({ vehicleType: null, emergencyContactPhone: null, languages: [] }), NOW)).toEqual([
      'At least one language you speak',
      'An emergency contact',
      'How you will travel (vehicle)',
    ]);
  });

  it('holds the age floors: 18 for a publisher agent, 21 for an advertiser agent', () => {
    const nineteen = new Date('2007-06-01');
    expect(profileGaps('PUBLISHER', facts({ dateOfBirth: nineteen }), NOW)).toEqual([]);
    expect(profileGaps('ADVERTISER', facts({ dateOfBirth: nineteen }), NOW)).toContain('You must be 21 or older');
    expect(ageOn(new Date('2008-09-21'), NOW)).toBe(17);
    expect(ageOn(new Date('2008-09-20'), NOW)).toBe(18);
  });

  it('an advertiser agent needs 12th pass, sales years (0 is fine) and a reference (decision 6)', () => {
    expect(ADVERTISER_MIN_EDUCATION).toBe('CLASS_12');
    expect(meetsEducationFloor('CLASS_10')).toBe(false);
    expect(meetsEducationFloor('DIPLOMA')).toBe(true);
    expect(profileGaps('ADVERTISER', facts({ highestEducation: 'CLASS_10', salesExperienceYears: null, referenceCount: 0 }), NOW)).toEqual([
      'Advertiser agents need 12th pass or above',
      'Years of sales experience (0 is fine)',
      'At least one reference',
    ]);
    expect(profileGaps('ADVERTISER', facts({ salesExperienceYears: 0 }), NOW)).toEqual([]);
  });
});

describe('the papers', () => {
  it('is complete when every required kind is filed and nothing is flagged', () => {
    const filed = requiredDocuments('PUBLISHER', 'NONE').map((kind) => ({ kind, status: 'SUBMITTED' as const }));
    expect(documentsView('PUBLISHER', 'NONE', filed)).toMatchObject({ missing: [], actionNeeded: [], complete: true });
  });

  it('a flagged or re-requested paper is action needed, and blocks completeness', () => {
    const filed = requiredDocuments('PUBLISHER', 'NONE').map((kind) => ({ kind, status: kind === 'PAN' ? ('FLAGGED' as const) : ('APPROVED' as const) }));
    expect(documentsView('PUBLISHER', 'NONE', filed)).toMatchObject({ actionNeeded: ['PAN'], complete: false });
  });

  it('masks numbers the way the screen shows them and hashes them for matching', () => {
    expect(maskDocumentNumber('AADHAAR_FRONT', '1234 5678 9012')).toBe('********9012');
    expect(maskDocumentNumber('PAN', 'abcde1234f')).toBe('ABCDE****F');
    expect(maskDocumentNumber('DRIVING_LICENCE_FRONT', 'KA0120190001234')).toBe('***********1234');
    expect(hashDocumentNumber('PAN', 'ABCDE1234F')).toBe(hashDocumentNumber('PAN', 'abcde 1234f'));
    expect(hashDocumentNumber('PAN', 'ABCDE1234F')).not.toBe(hashDocumentNumber('AADHAAR_FRONT', 'ABCDE1234F'));
  });

  it('maps the desk\'s seven KYC slots onto document kinds', () => {
    expect(kindsForKycSlots({ govIdType: 'AADHAAR', govIdFrontUrl: 'u1', govIdBackUrl: 'u2', panNumber: 'ABCDE1234F', panFrontUrl: 'u3', selfieUrl: 'u4' }).map((d) => d.kind)).toEqual([
      'AADHAAR_FRONT', 'AADHAAR_BACK', 'PAN', 'SELFIE',
    ]);
    expect(kindsForKycSlots({ govIdType: 'DRIVING_LICENCE', govIdFrontUrl: 'u1', govIdBackUrl: 'u2' }).map((d) => d.kind)).toEqual(['DRIVING_LICENCE_FRONT', 'DRIVING_LICENCE_BACK']);
    expect(kindsForKycSlots({ govIdType: 'PASSPORT', govIdFrontUrl: 'u1' })).toEqual([{ kind: 'PASSPORT', url: 'u1', number: null }]);
  });
});

describe('the ladder', () => {
  const docsDone = documentsView('PUBLISHER', 'NONE', requiredDocuments('PUBLISHER', 'NONE').map((kind) => ({ kind, status: 'SUBMITTED' as const })));
  /** AG-4: a screen nobody has judged yet — the desk's paper check is owed. */
  const unscreened = screeningOf({ side: 'PUBLISHER', screenedAt: null, identityVerified: false, papersApproved: false, assessment: { required: false, passed: false, bestPercent: null, passPercent: null }, interviews: [] });

  it('opens at the first step that is not done, and can be submitted only when all four are', () => {
    const half = ladderOf({ stage: 'DOCUMENTS', side: 'PUBLISHER', profileGaps: [], documents: docsDone, bankReady: false, agreementAccepted: false, trainingCertified: false, trainingAvailable: true, screening: unscreened });
    expect(half.nextStep).toBe('BANK');
    expect(half.canSubmit).toBe(false);
    expect(stageForUnsubmitted(half)).toBe('BANK');

    const full = ladderOf({ stage: 'AGREEMENT', side: 'PUBLISHER', profileGaps: [], documents: docsDone, bankReady: true, agreementAccepted: true, trainingCertified: false, trainingAvailable: true, screening: unscreened });
    expect(full.nextStep).toBeNull();
    expect(full.canSubmit).toBe(true);
    expect(stageForUnsubmitted(full)).toBe('AGREEMENT');
  });

  it('training is shown before submission and demanded after; the screen is judged by side (AG-4)', () => {
    const full = ladderOf({ stage: 'AGREEMENT', side: 'ADVERTISER', profileGaps: [], documents: docsDone, bankReady: true, agreementAccepted: true, trainingCertified: false, trainingAvailable: true, screening: unscreened });
    expect(full.steps.find((s) => s.key === 'TRAINING')?.state).toBe('PENDING');
    expect(full.canSubmit).toBe(true);

    // A field agent is screened on paper: identity verified and every paper approved, or the desk's tick.
    const none = { required: false, passed: false, bestPercent: null, passPercent: null };
    expect(screeningOf({ side: 'PUBLISHER', screenedAt: null, identityVerified: true, papersApproved: true, assessment: none, interviews: [] })).toMatchObject({ done: true, owedBy: null });
    expect(screeningOf({ side: 'PUBLISHER', screenedAt: null, identityVerified: true, papersApproved: false, assessment: none, interviews: [] })).toMatchObject({ done: false, owedBy: 'DESK', missing: ["The desk's paper check"] });
    expect(screeningOf({ side: 'PUBLISHER', screenedAt: new Date(), identityVerified: false, papersApproved: false, assessment: none, interviews: [] }).done).toBe(true);

    // A sales agent sits the assessment (theirs) and an interview (the desk's); round two is asked for G3/G4.
    const sales = (over: Partial<Parameters<typeof screeningOf>[0]> = {}) =>
      screeningOf({ side: 'ADVERTISER', screenedAt: null, identityVerified: true, papersApproved: true, assessment: { required: true, passed: false, bestPercent: 45, passPercent: 60 }, interviews: [], ...over });
    expect(sales()).toMatchObject({ done: false, owedBy: 'APPLICANT', missing: ['The sales assessment — best 45%, 60% to pass', 'An interview with ADX — the desk schedules it'] });
    const slot = { round: 1, outcome: 'SCHEDULED' as const, scheduledAt: new Date('2026-09-25T05:00:00Z'), marks: null };
    expect(sales({ assessment: { required: true, passed: true, bestPercent: 70, passPercent: 60 }, interviews: [slot] })).toMatchObject({ done: false, owedBy: 'DESK', missing: ['The interview on 2026-09-25'], nextInterview: slot });
    const passed = sales({ assessment: { required: true, passed: true, bestPercent: 70, passPercent: 60 }, interviews: [{ ...slot, outcome: 'PASSED', marks: 4 }] });
    expect(passed).toMatchObject({ done: true, interviewPassed: true, secondRoundPassed: false });
    expect(activationGaps({ screening: passed, trainingCertified: true, trainingAvailable: true, side: 'ADVERTISER', grade: 'G3', waiveScreening: false, waiveTraining: false })).toEqual([{ code: 'SCREENING_INCOMPLETE', message: 'A G3 activation needs a passed second-round interview' }]);
    expect(activationGaps({ screening: passed, trainingCertified: false, trainingAvailable: true, side: 'ADVERTISER', grade: 'G2', waiveScreening: false, waiveTraining: false })).toEqual([{ code: 'TRAINING_INCOMPLETE', message: 'The ADX training is not certified yet' }]);
    // No lesson published for the side: the training gate does not bind; a waiver lifts the screen.
    expect(activationGaps({ screening: sales(), trainingCertified: false, trainingAvailable: false, side: 'ADVERTISER', grade: 'G2', waiveScreening: true, waiveTraining: false })).toEqual([]);

    // After submission the stage follows the screen and the certificate.
    const base = { stage: 'UNDER_REVIEW' as const, side: 'ADVERTISER' as const, profileGaps: [], documents: docsDone, bankReady: true, agreementAccepted: true, trainingAvailable: true };
    const submitted = ladderOf({ ...base, trainingCertified: false, screening: sales() });
    expect(submitted.steps.find((s) => s.key === 'SCREENING')).toMatchObject({ state: 'ACTION_NEEDED' });
    expect(submitted.steps.find((s) => s.key === 'TRAINING')).toMatchObject({ state: 'ACTION_NEEDED' });
    expect(stageForSubmitted(submitted)).toBe('SCREENING');
    expect(stageForSubmitted(ladderOf({ ...base, trainingCertified: false, screening: passed }))).toBe('TRAINING');
    expect(stageForSubmitted(ladderOf({ ...base, trainingCertified: true, screening: passed }))).toBe('UNDER_REVIEW');
    // An expired paper is the applicant's to renew.
    expect(documentsView('PUBLISHER', 'SCOOTER', [{ kind: 'DRIVING_LICENCE_FRONT', status: 'EXPIRED' }]).actionNeeded).toEqual(['DRIVING_LICENCE_FRONT']);
  });

  it('a submitted application waits; it cannot be submitted twice', () => {
    const waiting = ladderOf({ stage: 'UNDER_REVIEW', side: 'PUBLISHER', profileGaps: [], documents: docsDone, bankReady: true, agreementAccepted: true, trainingCertified: true, trainingAvailable: true, screening: unscreened });
    expect(waiting.steps.find((s) => s.key === 'REVIEW')?.state).toBe('WAITING');
    expect(waiting.canSubmit).toBe(false);
  });
});

describe('the desk\'s moves', () => {
  it('activates only from review, screening, training or a hold', () => {
    expect(decisionAllowed('UNDER_REVIEW', 'ACTIVATE')).toBe(true);
    expect(decisionAllowed('ON_HOLD', 'ACTIVATE')).toBe(true);
    expect(decisionAllowed('DOCUMENTS', 'ACTIVATE')).toBe(false);
    expect(decisionAllowed('ACTIVE', 'ACTIVATE')).toBe(false);
  });

  it('rejects anything not settled, holds anything open, resumes only a hold', () => {
    expect(decisionAllowed('PROFILE', 'REJECT')).toBe(true);
    expect(decisionAllowed('EXITED', 'REJECT')).toBe(false);
    expect(decisionAllowed('ACTIVE', 'HOLD')).toBe(true);
    expect(decisionAllowed('REJECTED', 'HOLD')).toBe(false);
    expect(decisionAllowed('ON_HOLD', 'RESUME')).toBe(true);
    expect(decisionAllowed('UNDER_REVIEW', 'RESUME')).toBe(false);
  });

  it('the applicant may withdraw until activation; an engagement ends from active or held', () => {
    expect(withdrawalAllowed('UNDER_REVIEW')).toBe(true);
    expect(withdrawalAllowed('ACTIVE')).toBe(false);
    expect(exitAllowed('ACTIVE')).toBe(true);
    expect(exitAllowed('ON_HOLD')).toBe(true);
    expect(exitAllowed('UNDER_REVIEW')).toBe(false);
  });
});
