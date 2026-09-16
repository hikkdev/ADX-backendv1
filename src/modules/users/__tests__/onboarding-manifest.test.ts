import { describe, expect, it } from 'vitest';
import { buildOnboardingManifest } from '../onboarding-manifest';

/**
 * The ladder, as data.
 *
 * What is pinned is what the frames number: Government ID Front is Step 6
 * and the selfie Step 10 for an account with a business behind it; Lot D
 * (Q131) adds the liveness video as Step 11 on the manual branch, so the
 * review is Step 12; an individual has no business or contact-person step
 * and climbs ten. And that every tile on the front-of-ID step answers which
 * ID it is. Lot D (Q42/Q129): while NEEDS_INFO the ladder is only the flagged
 * tiles and the review step, and the Digio switch is reported.
 */

const keys = (party: 'PUBLISHER' | 'ADVERTISER', type: 'INDIVIDUAL' | 'BUSINESS' | 'ORGANISATION') =>
  buildOnboardingManifest(party, type).steps.map((s) => s.key);

describe('the publisher ladder', () => {
  it('is the eleven the frames number plus the liveness video, for a business', () => {
    expect(keys('PUBLISHER', 'BUSINESS')).toEqual([
      'account-type',
      'details',
      'business',
      'contact',
      'kyc-intro',
      'gov-id-front',
      'gov-id-back',
      'pan',
      'address-proof',
      'selfie',
      'liveness',
      'checklist',
    ]);
    const manifest = buildOnboardingManifest('PUBLISHER', 'BUSINESS');
    const steps = manifest.steps;
    expect(steps.findIndex((s) => s.key === 'gov-id-front') + 1).toBe(6);
    expect(steps.findIndex((s) => s.key === 'selfie') + 1).toBe(10);
    expect(steps.findIndex((s) => s.key === 'liveness') + 1).toBe(11);
    expect(manifest.mode).toBe('full');
    expect(manifest.verification).toEqual({
      digio: { available: true, provider: 'DIGIO', retryAfter: null },
      liveness: { required: true, status: null },
      kycStatus: null,
      reviewNote: null,
    });
  });

  it('skips the business and contact steps for an individual', () => {
    expect(keys('PUBLISHER', 'INDIVIDUAL')).toHaveLength(10);
    expect(keys('PUBLISHER', 'INDIVIDUAL')).not.toContain('business');
    expect(keys('PUBLISHER', 'INDIVIDUAL')).not.toContain('contact');
  });

  it('names the organisation step for an organisation', () => {
    const business = buildOnboardingManifest('PUBLISHER', 'ORGANISATION').steps.find((s) => s.key === 'business');
    expect(business).toMatchObject({ kind: 'form', title: 'Organisation information' });
  });
});

describe('the advertiser ladder', () => {
  it('is the same ladder with the other noun', () => {
    expect(keys('ADVERTISER', 'BUSINESS')).toEqual(keys('PUBLISHER', 'BUSINESS'));
    const details = buildOnboardingManifest('ADVERTISER', 'BUSINESS').steps[1];
    expect(details).toMatchObject({ key: 'details', title: 'Advertiser details' });
  });
});

describe('the capture steps', () => {
  const manifest = buildOnboardingManifest('PUBLISHER', 'INDIVIDUAL');
  const step = (key: string) => manifest.steps.find((s) => s.key === key)!;

  it('front of ID: three tiles, each answering which ID it is, all to one column', () => {
    const front = step('gov-id-front');
    if (front.kind !== 'capture') throw new Error('not a capture step');
    expect(front.documents.map((d) => d.sets)).toEqual([
      { field: 'govIdType', value: 'AADHAAR' },
      { field: 'govIdType', value: 'PASSPORT' },
      { field: 'govIdType', value: 'DRIVING_LICENCE' },
    ]);
    expect(new Set(front.documents.map((d) => d.field))).toEqual(new Set(['govIdFrontUrl']));
  });

  it('PAN: the number is typed, the photograph and signature are tiles', () => {
    const pan = step('pan');
    if (pan.kind !== 'capture') throw new Error('not a capture step');
    expect(pan.text).toMatchObject({ field: 'panNumber', maxLength: 10 });
    expect(new RegExp(pan.text!.pattern).test('ABCDE1234F')).toBe(true);
    expect(new RegExp(pan.text!.pattern).test('abcde1234f')).toBe(false);
    expect(pan.documents.map((d) => d.field)).toEqual(['panFrontUrl', 'panSignatureUrl']);
  });

  it('address proof: three alternatives, each a photograph or a PDF, under UPLOAD DOCUMENT', () => {
    const address = step('address-proof');
    if (address.kind !== 'capture') throw new Error('not a capture step');
    expect(address.documents.map((d) => d.sets?.value)).toEqual(['UTILITY_BILL', 'RENT_AGREEMENT', 'BANK_STATEMENT']);
    expect(address.documents.every((d) => d.field === 'addressProofUrl' && d.pdf === true)).toBe(true);
    // The frame's primary (4588:2739) — the only capture step whose button is not the photograph's.
    expect(address.cta).toBe('Upload document');
    // An identity document is a photograph: no other step's tile takes a PDF.
    for (const key of ['gov-id-front', 'gov-id-back', 'pan', 'selfie'] as const) {
      const other = step(key);
      if (other.kind !== 'capture') throw new Error('not a capture step');
      expect(other.documents.some((d) => d.pdf)).toBe(false);
    }
  });

  it('selfie: the camera, front face, with the three guidance rows the frame draws', () => {
    const selfie = step('selfie');
    if (selfie.kind !== 'capture') throw new Error('not a capture step');
    expect(selfie.documents).toEqual([expect.objectContaining({ field: 'selfieUrl', source: 'camera', front: true })]);
    expect(selfie.guidance?.map((g) => g.label)).toEqual(['Position', 'Lighting', 'Match']);
    expect(selfie.cta).toBe('Take selfie');
  });
});

/* DR 08 4588:2614: three tiles on the back step, the passport's inert. */
describe('the back of the ID', () => {
  it('mirrors the front, shows only the chosen kind, and lets a passport skip the step', () => {
    const step = buildOnboardingManifest('PUBLISHER', 'INDIVIDUAL').steps.find((s) => s.key === 'gov-id-back');
    expect(step?.kind).toBe('capture');
    if (step?.kind !== 'capture') return;
    expect(step.documents.map((d) => d.onlyWhen?.value)).toEqual(['AADHAAR', 'PASSPORT', 'DRIVING_LICENCE']);
    const passport = step.documents.find((d) => d.key === 'passport-back');
    expect(passport?.inert).toBe(true);
    expect(passport?.hint).toBe('Not applicable — back not required');
    expect(step.skippableWhen).toEqual({ field: 'govIdType', value: 'PASSPORT' });
  });
});

/* Lot D (Q131): the liveness video, the last capture before the review. */
describe('the liveness step', () => {
  it('is a camera clip to the UserKyc row, drawn with its three guidance rows', () => {
    const step = buildOnboardingManifest('ADVERTISER', 'INDIVIDUAL').steps.find((s) => s.key === 'liveness');
    expect(step?.kind).toBe('capture');
    if (step?.kind !== 'capture') return;
    expect(step.title).toBe('Record a short video');
    expect(step.documents).toEqual([expect.objectContaining({ field: 'selfVideoUrl', source: 'camera', front: true, video: true })]);
    expect(step.guidance).toHaveLength(3);
  });
});

/* Lot D (Q42/Q129): what the ladder knows about the record it climbs towards. */
describe('the partial ladder and the Digio switch', () => {
  it('draws only the flagged tiles and the review step while NEEDS_INFO, each tile carrying the note', () => {
    const manifest = buildOnboardingManifest('PUBLISHER', 'BUSINESS', {
      status: 'NEEDS_INFO',
      reviewNote: 'Two documents were unreadable.',
      flagged: [
        { field: 'govIdFrontUrl', note: 'Glare over the number' },
        { field: 'selfieUrl', note: null },
      ],
    });
    expect(manifest.mode).toBe('partial');
    expect(manifest.steps.map((s) => s.key)).toEqual(['gov-id-front', 'selfie', 'checklist']);
    const front = manifest.steps[0];
    if (front?.kind !== 'capture') throw new Error('not a capture step');
    expect(front.documents.every((d) => d.flagged === true && d.note === 'Glare over the number')).toBe(true);
    const selfie = manifest.steps[1];
    if (selfie?.kind !== 'capture') throw new Error('not a capture step');
    // A flag with no note of its own carries the record's review note.
    expect(selfie.documents[0]).toMatchObject({ flagged: true, note: 'Two documents were unreadable.' });
    expect(manifest.steps[2]).toMatchObject({ key: 'checklist', subtitle: 'Two documents were unreadable.', cta: 'Resubmit for review' });
    expect(manifest.verification.kycStatus).toBe('NEEDS_INFO');
  });

  it('brings the video step back when the liveness video was rejected', () => {
    const manifest = buildOnboardingManifest('PUBLISHER', 'INDIVIDUAL', {
      status: 'NEEDS_INFO',
      flagged: [],
      liveness: { status: 'REJECTED', rejectionReason: 'Too dark to see a face' },
    });
    expect(manifest.steps.map((s) => s.key)).toEqual(['liveness', 'checklist']);
    const video = manifest.steps[0];
    if (video?.kind !== 'capture') throw new Error('not a capture step');
    expect(video.documents[0]).toMatchObject({ flagged: true, note: 'Too dark to see a face' });
  });

  it('keeps the full ladder for every other status and reports the Digio switch as given', () => {
    const manifest = buildOnboardingManifest('PUBLISHER', 'INDIVIDUAL', {
      status: 'PENDING',
      liveness: { status: 'PENDING' },
      digio: { available: false, provider: 'DEGRADED', retryAfter: 300 },
    });
    expect(manifest.mode).toBe('full');
    expect(manifest.steps).toHaveLength(10);
    expect(manifest.verification.digio).toEqual({ available: false, provider: 'DEGRADED', retryAfter: 300 });
    expect(manifest.verification.liveness).toEqual({ required: true, status: 'PENDING' });
  });
});
