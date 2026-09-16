import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { onboardingTemplateSchema, templateIssues, type OnboardingTemplate } from '../../app-config';
import { buildOnboardingManifest, CODE_ONBOARDING_TEMPLATE, type ManifestKycContext } from '../onboarding-manifest';

/**
 * Q83 — the ladder as data.
 *
 * What is pinned: the manifest is byte for byte what the Lot D code ladder
 * served (a fixture captured before the change), whether it is composed
 * from the code template or from that template after the JSON round trip
 * the AppConfig column gives it; the version claim follows the template;
 * an edited template renders; and the validator refuses a ladder that
 * misses a required KYC column, names a step the library lacks, or binds a
 * tile to a column that is not one of the seven.
 */

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'onboarding-manifest.lot-d.json'), 'utf8')) as Record<string, unknown>;

const full: ManifestKycContext = { status: 'PENDING', liveness: { status: 'PENDING' }, digio: { available: false, provider: 'DEGRADED', retryAfter: 300 } };
const partial: ManifestKycContext = {
  status: 'NEEDS_INFO',
  reviewNote: 'Two documents were unreadable.',
  flagged: [
    { field: 'govIdFrontUrl', note: 'Glare over the number' },
    { field: 'selfieUrl', note: null },
    { field: 'addressProofUrl', note: 'Expired' },
  ],
  liveness: { status: 'REJECTED', rejectionReason: 'Too dark' },
};
const parties = ['PUBLISHER', 'ADVERTISER'] as const;
const types = ['INDIVIDUAL', 'BUSINESS', 'ORGANISATION'] as const;

const withoutVersion = (manifest: object) => {
  const { manifestVersion: _version, ...rest } = manifest as { manifestVersion: number };
  return rest;
};
const clone = (): OnboardingTemplate => JSON.parse(JSON.stringify(CODE_ONBOARDING_TEMPLATE)) as OnboardingTemplate;

/** Object keys in reverse order at every level — the way a jsonb column might hand them back. */
function scrambleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrambleKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).reverse()) out[k] = scrambleKeys(v);
    return out;
  }
  return value;
}

describe('byte identity', () => {
  it('serves what the Lot D code ladder served, for every party, type and mode', () => {
    // The fixture is buildOnboardingManifest's output as it stood before the
    // ladder became data, captured with these exact contexts. Only the new
    // manifestVersion claim is allowed to differ.
    for (const party of parties) {
      for (const type of types) {
        const wantFull = JSON.stringify(fixture[`${party}:${type}:full`], null, 2);
        const wantPartial = JSON.stringify(fixture[`${party}:${type}:partial`], null, 2);
        expect(JSON.stringify(withoutVersion(buildOnboardingManifest(party, type, full)), null, 2)).toBe(wantFull);
        expect(JSON.stringify(withoutVersion(buildOnboardingManifest(party, type, partial)), null, 2)).toBe(wantPartial);
      }
    }
  });

  it('is the same whether composed from the code ladder or from the seeded row', () => {
    // What seedConfig writes is CODE_ONBOARDING_TEMPLATE after a round trip
    // through a jsonb column, which hands keys back in its own order; the
    // service composes from the parser's output, and the manifest must not
    // know which it came from.
    const seeded = onboardingTemplateSchema.parse(scrambleKeys(CODE_ONBOARDING_TEMPLATE)) as OnboardingTemplate;
    for (const party of parties) {
      for (const type of types) {
        expect(JSON.stringify(buildOnboardingManifest(party, type, full, seeded))).toBe(JSON.stringify(buildOnboardingManifest(party, type, full)));
        expect(JSON.stringify(buildOnboardingManifest(party, type, partial, seeded))).toBe(JSON.stringify(buildOnboardingManifest(party, type, partial)));
      }
    }
  });

  it('claims the template version it was composed from — 1 for the code ladder', () => {
    expect(buildOnboardingManifest('PUBLISHER', 'INDIVIDUAL').manifestVersion).toBe(1);
    const later = { ...CODE_ONBOARDING_TEMPLATE, version: 4 };
    expect(buildOnboardingManifest('PUBLISHER', 'INDIVIDUAL', {}, later).manifestVersion).toBe(4);
    expect(buildOnboardingManifest('PUBLISHER', 'BUSINESS', partial, later).manifestVersion).toBe(4);
  });
});

describe('the code ladder against the vocabulary', () => {
  it('passes the schema and covers every required column on all six ladders', () => {
    expect(onboardingTemplateSchema.safeParse(CODE_ONBOARDING_TEMPLATE).success).toBe(true);
    expect(templateIssues(CODE_ONBOARDING_TEMPLATE)).toEqual([]);
  });
});

describe('an edited template', () => {
  it('renders a renamed step, a dropped contact step and a review kind in place of the checklist', () => {
    const edited = clone();
    edited.version = 2;
    edited.steps['selfie'] = { ...edited.steps['selfie']!, title: 'A photo of you' };
    edited.steps['checklist'] = { key: 'review', kind: 'review', title: 'Look it over', subtitle: 'Everything you gave us', cta: 'Send' };
    edited.ladders.PUBLISHER.BUSINESS = edited.ladders.PUBLISHER.BUSINESS.filter((id) => id !== 'contact');
    expect(templateIssues(edited)).toEqual([]);

    const manifest = buildOnboardingManifest('PUBLISHER', 'BUSINESS', {}, edited);
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.steps.map((s) => s.key)).not.toContain('contact');
    expect(manifest.steps.find((s) => s.key === 'selfie')).toMatchObject({ title: 'A photo of you' });
    expect(manifest.steps[manifest.steps.length - 1]).toMatchObject({ key: 'review', kind: 'review' });

    // Partial mode finds the review step by kind, not by the code ladder's key.
    const resubmit = buildOnboardingManifest('PUBLISHER', 'BUSINESS', { status: 'NEEDS_INFO', flagged: [{ field: 'panFrontUrl', note: 'Cut off' }] }, edited);
    expect(resubmit.steps.map((s) => s.key)).toEqual(['pan', 'review']);
    expect(resubmit.steps[1]).toMatchObject({ kind: 'review', title: 'Send the flagged documents again', cta: 'Resubmit for review' });
  });
});

describe('the validator', () => {
  it('refuses a ladder that never captures a required column', () => {
    const noSelfie = clone();
    noSelfie.ladders.ADVERTISER.INDIVIDUAL = noSelfie.ladders.ADVERTISER.INDIVIDUAL.filter((id) => id !== 'selfie');
    expect(templateIssues(noSelfie)).toEqual([
      { path: ['ladders', 'ADVERTISER', 'INDIVIDUAL'], message: 'The ADVERTISER INDIVIDUAL ladder never captures selfieUrl' },
    ]);
    expect(onboardingTemplateSchema.safeParse(noSelfie).success).toBe(false);
  });

  it('refuses a ladder naming a step the library lacks', () => {
    const ghost = clone();
    ghost.ladders.PUBLISHER.ORGANISATION.push('trust-deed');
    expect(templateIssues(ghost)).toEqual([{ path: ['ladders', 'PUBLISHER', 'ORGANISATION', 12], message: '`trust-deed` is not a step in the library' }]);
  });

  it('does not count an inert tile as capturing its column', () => {
    const inert = clone();
    const pan = inert.steps['pan'];
    if (pan?.kind !== 'capture') throw new Error('not a capture step');
    pan.documents = pan.documents.map((doc) => ({ ...doc, inert: true }));
    expect(templateIssues(inert).map((i) => i.message)).toEqual(expect.arrayContaining(['The PUBLISHER INDIVIDUAL ladder never captures panFrontUrl']));
  });

  it('refuses a tile bound to a column that is not one of the seven', () => {
    const unknownColumn = JSON.parse(JSON.stringify(CODE_ONBOARDING_TEMPLATE)) as { steps: Record<string, { documents?: { field: string }[] }> };
    unknownColumn.steps['selfie']!.documents![0]!.field = 'gstUrl';
    const parsed = onboardingTemplateSchema.safeParse(unknownColumn);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'steps.selfie.documents.0.field')).toBe(true);
  });

  it('refuses a step of a kind no phone renders, and a step key shown twice on one ladder', () => {
    const odd = JSON.parse(JSON.stringify(CODE_ONBOARDING_TEMPLATE)) as { steps: Record<string, unknown>; ladders: OnboardingTemplate['ladders'] };
    odd.steps['slider'] = { key: 'price', kind: 'slider', title: 'Monthly price' };
    expect(onboardingTemplateSchema.safeParse(odd).success).toBe(false);

    const twice = clone();
    twice.ladders.PUBLISHER.INDIVIDUAL.push('selfie');
    expect(templateIssues(twice).map((i) => i.message)).toContain('Step key `selfie` appears twice on this ladder');
  });
});
