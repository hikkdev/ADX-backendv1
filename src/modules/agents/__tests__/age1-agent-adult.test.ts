import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * AGE-1 (the owner, 29 Sep 2026): anyone may use ADX; an order needs 18 or
 * over. An agent is engaged for work, so the agent application keeps the
 * adult rule it had: the desk's copy of the applicant's date of birth is
 * refused a day short of eighteen, and the ladder still asks 18 (publisher
 * side) or 21 (advertiser side) before the profile step is complete.
 */

import { deskProfileSchema } from '../application/application.schema';
import { profileGaps } from '../application/application.rules';

afterEach(() => {
  vi.useRealTimers();
});

describe('the agent application keeps the adult rule', () => {
  it("the desk's profile write refuses an applicant under 18", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T03:30:00Z'));
    expect(deskProfileSchema.safeParse({ dateOfBirth: '2008-09-29' }).success).toBe(true);
    expect(deskProfileSchema.safeParse({ dateOfBirth: '2008-09-30' }).success).toBe(false);
    expect(deskProfileSchema.safeParse({ dateOfBirth: '2012-01-01' }).success).toBe(false);
  });

  it('the ladder still names the age a side needs', () => {
    const now = new Date('2026-09-29T03:30:00Z');
    const facts = {
      name: 'Ravi',
      dateOfBirth: new Date('2010-01-01T00:00:00Z'),
      gender: 'MALE',
      city: 'Pune',
      languages: ['Marathi'],
      vehicleType: 'SCOOTER' as const,
      currentAddress: 'Here',
      permanentAddress: 'There',
      emergencyContactName: 'Asha',
      emergencyContactPhone: '9876543210',
      highestEducation: 'CLASS_12' as const,
      salesExperienceYears: 1,
      referenceCount: 2,
    };
    expect(profileGaps('PUBLISHER', facts, now)).toContain('You must be 18 or older');
    expect(profileGaps('ADVERTISER', { ...facts, dateOfBirth: new Date('2006-01-01T00:00:00Z') }, now)).toContain('You must be 21 or older');
  });
});
