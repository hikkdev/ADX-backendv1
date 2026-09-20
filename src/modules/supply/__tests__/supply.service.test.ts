import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupplyRepository } from '../supply.repository';

// vi.hoisted so the stub exists before vi.mock's factory runs during the static
// import below — same reason as the notifications tests.
const repository = vi.hoisted(
  () =>
    ({
      funnel: vi.fn(),
      publisherFunnelRows: vi.fn(),
      activeTemplate: vi.fn(),
      findAcceptance: vi.fn(),
      findPlatformAcceptance: vi.fn(),
      createAcceptance: vi.fn(),
      markPublisherActivated: vi.fn(),
      createAttempt: vi.fn(),
      findAttempt: vi.fn(),
      listAttempts: vi.fn(),
      setAttemptStatus: vi.fn(),
      addListingsToAttempt: vi.fn(),
      attemptProgress: vi.fn(),
      advanceAttemptListings: vi.fn(),
      addDocument: vi.fn(),
      findDocument: vi.fn(),
      reviewDocument: vi.fn(),
      listDocuments: vi.fn(),
      documentsCleared: vi.fn(),
      createVerification: vi.fn(),
      findVerification: vi.fn(),
      reviewVerification: vi.fn(),
      listVerifications: vi.fn(),
      verificationsDue: vi.fn(),
      findListing: vi.fn(),
      setListingStatus: vi.fn(),
      // QR-24
      setRights: vi.fn(),
      rightsDue: vi.fn(),
      publisherUserId: vi.fn(),
      publisherIdOfUser: vi.fn(),
      markListingVerified: vi.fn(),
      markDocumentsCleared: vi.fn(),
      createClaim: vi.fn(),
      findClaim: vi.fn(),
      listClaims: vi.fn(),
      decideClaim: vi.fn(),
      assignListingOwner: vi.fn(),
      openComplianceCase: vi.fn(),
      findOpenCaseForListing: vi.fn(),
      findCase: vi.fn(),
      listCases: vi.fn(),
      addContactAttempt: vi.fn(),
      setCaseStatus: vi.fn(),
      casesPastDue: vi.fn(),
      openHold: vi.fn(),
      releaseHolds: vi.fn(),
      listingIdsWithOpenCase: vi.fn(),
      openHolds: vi.fn(),
      openComplianceCases: vi.fn(),
      suspendForCases: vi.fn(),
    }) satisfies Record<keyof SupplyRepository, ReturnType<typeof vi.fn>>,
);

vi.mock('../prisma-supply.repository', () => ({ prismaSupplyRepository: repository }));

import {
  CADENCE_DAYS,
  RISK_WINDOW_DAYS,
  acceptListingAgreement,
  acceptPlatformAgreement,
  attachListingToAttempt,
  claimListing,
  createAttempt,
  decideClaim,
  distanceMetres,
  renderListingAgreement,
  reviewDocument,
  reviewVerification,
  runEnforcementSweep,
  submitVerification,
  verificationState,
} from '../supply.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-07T00:00:00.000Z');

/** Only the fields the service reads; the rest of Listing is irrelevant here. */
const listing = (over: Record<string, unknown> = {}) =>
  ({
    id: 'lst-1',
    title: 'MG Road Billboard',
    address: 'MG Road',
    city: 'Bengaluru',
    status: 'AWAITING_SITE_VERIFICATION',
    removability: 'PERMANENT',
    latitude: 12.9716,
    longitude: 77.5946,
    verifiedAt: null,
    verificationExpiresAt: null,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('distance and tolerance', () => {
  it('measures a short offset in metres', () => {
    // ~111 m per 0.001 degree of latitude at the equator.
    const d = distanceMetres(
      { latitude: 12.9716, longitude: 77.5946 },
      { latitude: 12.9725, longitude: 77.5946 },
    );
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(105);
  });

  it('accepts a capture inside the plain tolerance', async () => {
    repository.findListing.mockResolvedValue(listing());
    repository.createVerification.mockResolvedValue({ id: 'ver-1' });

    const result = await submitVerification({
      listingId: 'lst-1',
      type: 'SELF_REVERIFICATION',
      photoUrl: 'https://cdn.adx.in/p.jpg',
      latitude: 12.9716,
      longitude: 77.5946,
      capturedAt: NOW,
    });

    expect(result.withinTolerance).toBe(true);
    expect(result.tolerance).toBe(15);
  });

  it('widens the accepted radius when the site QR was scanned too', async () => {
    repository.findListing.mockResolvedValue(listing());
    repository.createVerification.mockResolvedValue({ id: 'ver-2' });

    // ~30 m away: outside the plain tolerance, inside the QR-backed one.
    const away = { latitude: 12.9716 + 0.00027, longitude: 77.5946 };

    const plain = await submitVerification({
      listingId: 'lst-1',
      type: 'SELF_REVERIFICATION',
      photoUrl: 'https://cdn.adx.in/p.jpg',
      ...away,
      capturedAt: NOW,
    });
    expect(plain.withinTolerance).toBe(false);

    const withQr = await submitVerification({
      listingId: 'lst-1',
      type: 'SELF_REVERIFICATION',
      photoUrl: 'https://cdn.adx.in/p.jpg',
      ...away,
      qrScanned: true,
      capturedAt: NOW,
    });
    expect(withQr.withinTolerance).toBe(true);
    expect(withQr.tolerance).toBe(40);
  });

  /*
   * The named-proof sequence. A guided agent visit walks a template's photo
   * requirements one at a time and submits them together, and these three
   * assertions are the whole contract: one visit is one verification, the
   * labels survive, and the first shot is still where a single-photo reader
   * looks.
   */
  it('keeps a whole named sequence as one verification', async () => {
    repository.findListing.mockResolvedValue(listing());
    repository.createVerification.mockResolvedValue({ id: 'ver-3' });

    await submitVerification({
      listingId: 'lst-1',
      type: 'AGENT_INITIAL',
      photos: [
        { url: 'https://cdn.adx.in/decal.jpg', label: 'The mirror decal' },
        { url: 'https://cdn.adx.in/angle.jpg', label: 'Decal from an angle' },
        { url: 'https://cdn.adx.in/zone.jpg', label: 'Reception / locker zone' },
      ],
      latitude: 12.9716,
      longitude: 77.5946,
      capturedAt: NOW,
    });

    expect(repository.createVerification).toHaveBeenCalledTimes(1);
    const written = repository.createVerification.mock.calls[0]![0];
    expect(written.photos).toEqual([
      { url: 'https://cdn.adx.in/decal.jpg', label: 'The mirror decal', order: 0 },
      { url: 'https://cdn.adx.in/angle.jpg', label: 'Decal from an angle', order: 1 },
      { url: 'https://cdn.adx.in/zone.jpg', label: 'Reception / locker zone', order: 2 },
    ]);
    // What the admin queue and the review screen read.
    expect(written.photoUrl).toBe('https://cdn.adx.in/decal.jpg');
  });

  it('still takes a lone photoUrl, and stores it as the one unnamed shot', async () => {
    repository.findListing.mockResolvedValue(listing());
    repository.createVerification.mockResolvedValue({ id: 'ver-4' });

    await submitVerification({
      listingId: 'lst-1',
      type: 'SELF_REVERIFICATION',
      photoUrl: 'https://cdn.adx.in/p.jpg',
      latitude: 12.9716,
      longitude: 77.5946,
      capturedAt: NOW,
    });

    const calls = repository.createVerification.mock.calls;
    const written = calls[calls.length - 1]![0];
    expect(written.photoUrl).toBe('https://cdn.adx.in/p.jpg');
    expect(written.photos).toEqual([
      { url: 'https://cdn.adx.in/p.jpg', label: null, order: 0 },
    ]);
  });

  it('refuses a submission with no photo at all', async () => {
    repository.findListing.mockResolvedValue(listing());

    await expect(
      submitVerification({
        listingId: 'lst-1',
        type: 'AGENT_INITIAL',
        photos: [],
        latitude: 12.9716,
        longitude: 77.5946,
        capturedAt: NOW,
      }),
    ).rejects.toThrow(/at least one photo/i);
  });
});

describe('verification state', () => {
  it('is unverified until a first verification lands', () => {
    expect(verificationState(listing(), NOW)).toBe('UNVERIFIED');
  });

  it('is fresh well before expiry and risky inside the window', () => {
    const fresh = listing({ verificationExpiresAt: new Date(NOW.getTime() + 60 * DAY) });
    expect(verificationState(fresh, NOW)).toBe('FRESH');

    const risky = listing({ verificationExpiresAt: new Date(NOW.getTime() + 10 * DAY) });
    expect(verificationState(risky, NOW)).toBe('RISKY');
  });

  it('uses the shorter window for a removable spot', () => {
    const at10Days = { verificationExpiresAt: new Date(NOW.getTime() + 10 * DAY) };
    // 10 days out is inside a hoarding's 15-day window but outside a decal's 7.
    expect(verificationState(listing({ ...at10Days }), NOW)).toBe('RISKY');
    expect(verificationState(listing({ ...at10Days, removability: 'REMOVABLE' }), NOW)).toBe(
      'FRESH',
    );
  });

  it('is lapsed once the date passes', () => {
    const lapsed = listing({ verificationExpiresAt: new Date(NOW.getTime() - DAY) });
    expect(verificationState(lapsed, NOW)).toBe('LAPSED');
  });
});

describe('agreements', () => {
  it('enumerates every listing in the rendered listing agreement', () => {
    const body = 'Only spots whose documents clear are published.\n\n{{listings}}';
    const rendered = renderListingAgreement(body, [
      listing(),
      listing({ id: 'lst-2', title: 'Hebbal Flyover', address: 'Hebbal' }),
    ]);

    expect(rendered).toContain('1. MG Road Billboard — MG Road, Bengaluru');
    expect(rendered).toContain('2. Hebbal Flyover — Hebbal, Bengaluru');
    expect(rendered).not.toContain('{{listings}}');
  });

  it('appends the enumeration when the template has no token', () => {
    const rendered = renderListingAgreement('Terms.', [listing()]);
    expect(rendered).toContain('Inventory covered by this agreement');
    expect(rendered).toContain('1. MG Road Billboard');
  });

  it('activates the publisher when the platform agreement is accepted', async () => {
    repository.activeTemplate.mockResolvedValue({ id: 'tpl-1', version: 3, body: 'Terms' });
    repository.findAcceptance.mockResolvedValue(null);
    repository.createAcceptance.mockResolvedValue({ id: 'acc-1' });

    await acceptPlatformAgreement({ publisherId: 'pub-1', acceptedByUserId: 'usr-1' });

    expect(repository.markPublisherActivated).toHaveBeenCalledWith('pub-1');
    expect(repository.createAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ templateKind: 'PLATFORM', templateVersion: 3 }),
    );
  });

  it('is idempotent: accepting the same version twice returns the first acceptance', async () => {
    repository.activeTemplate.mockResolvedValue({ id: 'tpl-1', version: 3, body: 'Terms' });
    repository.findAcceptance.mockResolvedValue({ id: 'acc-existing' });

    const result = await acceptPlatformAgreement({
      publisherId: 'pub-1',
      acceptedByUserId: 'usr-1',
    });

    expect(result).toEqual({ id: 'acc-existing' });
    expect(repository.createAcceptance).not.toHaveBeenCalled();
  });

  it('refuses a listing agreement before the platform agreement', async () => {
    repository.findAttempt.mockResolvedValue({
      id: 'att-1',
      publisherId: 'pub-1',
      status: 'AWAITING_ACCEPTANCE',
      listings: [listing()],
      _count: { listings: 1 },
    });
    repository.findPlatformAcceptance.mockResolvedValue(null);

    await expect(
      acceptListingAgreement({ attemptId: 'att-1', acceptedByUserId: 'usr-1' }),
    ).rejects.toMatchObject({ code: 'PLATFORM_AGREEMENT_REQUIRED' });
  });

  it('accepts an attempt with documents outstanding, and advances its listings', async () => {
    // The whole point of the conditional publication clause: ten of two hundred
    // documented is still an acceptable batch.
    repository.findAttempt.mockResolvedValue({
      id: 'att-1',
      publisherId: 'pub-1',
      status: 'AWAITING_ACCEPTANCE',
      listings: [listing(), listing({ id: 'lst-2' })],
      _count: { listings: 2 },
    });
    repository.findPlatformAcceptance.mockResolvedValue({ id: 'acc-platform' });
    repository.activeTemplate.mockResolvedValue({ id: 'tpl-2', version: 1, body: 'Terms' });
    repository.createAcceptance.mockResolvedValue({ id: 'acc-listing' });

    await acceptListingAgreement({ attemptId: 'att-1', acceptedByUserId: 'usr-1' });

    expect(repository.setAttemptStatus).toHaveBeenCalledWith('att-1', 'ACCEPTED');
    expect(repository.advanceAttemptListings).toHaveBeenCalledWith('att-1');
  });

  it('refuses to sign an agreement over a truncated listing set', async () => {
    // The repository caps how many listings come back with an attempt. Signing
    // that capped set would put a partial inventory list into a legal document.
    repository.findAttempt.mockResolvedValue({
      id: 'att-big',
      publisherId: 'pub-1',
      status: 'AWAITING_ACCEPTANCE',
      listings: [listing(), listing({ id: 'lst-2' })],
      _count: { listings: 1200 },
    });
    repository.findPlatformAcceptance.mockResolvedValue({ id: 'acc-platform' });

    await expect(
      acceptListingAgreement({ attemptId: 'att-big', acceptedByUserId: 'usr-1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.createAcceptance).not.toHaveBeenCalled();
  });

  it('will not create an unowned attempt for anything but a scrape', async () => {
    await expect(createAttempt({ origin: 'ADMIN_BULK' })).rejects.toMatchObject({
      statusCode: 400,
    });
    repository.createAttempt.mockResolvedValue({ id: 'att-scrape' });
    await expect(createAttempt({ origin: 'SCRAPE' })).resolves.toEqual({ id: 'att-scrape' });
  });
});

describe('Lot U: attaching a listing that already exists to an attempt', () => {
  it("puts the publisher's own listing under the attempt at AWAITING_AGREEMENT, without creating a row", async () => {
    repository.findAttempt.mockResolvedValue({ id: 'att-1', publisherId: 'pub-1', status: 'DRAFT', listings: [], _count: { listings: 0 } });
    repository.findListing.mockResolvedValue(listing({ id: 'lst-9', publisherId: 'pub-1', status: 'DRAFT', attemptId: null }));
    repository.assignListingOwner.mockResolvedValue(listing({ id: 'lst-9', publisherId: 'pub-1', status: 'AWAITING_AGREEMENT', attemptId: 'att-1' }));

    const attached = await attachListingToAttempt('att-1', 'lst-9');

    expect(repository.assignListingOwner).toHaveBeenCalledWith('lst-9', 'pub-1', 'att-1');
    expect(repository.addListingsToAttempt).not.toHaveBeenCalled();
    expect(attached.status).toBe('AWAITING_AGREEMENT');
  });

  it("refuses another publisher's listing, an accepted attempt, and a listing already under an attempt", async () => {
    repository.findAttempt.mockResolvedValue({ id: 'att-1', publisherId: 'pub-1', status: 'DRAFT', listings: [], _count: { listings: 0 } });
    repository.findListing.mockResolvedValue(listing({ id: 'lst-9', publisherId: 'pub-2', status: 'DRAFT', attemptId: null }));
    await expect(attachListingToAttempt('att-1', 'lst-9')).rejects.toMatchObject({ statusCode: 409 });

    repository.findListing.mockResolvedValue(listing({ id: 'lst-9', publisherId: 'pub-1', status: 'AWAITING_AGREEMENT', attemptId: 'att-0' }));
    await expect(attachListingToAttempt('att-1', 'lst-9')).rejects.toMatchObject({ statusCode: 409 });

    repository.findAttempt.mockResolvedValue({ id: 'att-1', publisherId: 'pub-1', status: 'ACCEPTED', listings: [], _count: { listings: 0 } });
    repository.findListing.mockResolvedValue(listing({ id: 'lst-9', publisherId: 'pub-1', status: 'DRAFT', attemptId: null }));
    await expect(attachListingToAttempt('att-1', 'lst-9')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.assignListingOwner).not.toHaveBeenCalled();

    repository.findAttempt.mockResolvedValue(null);
    await expect(attachListingToAttempt('att-x', 'lst-9')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('document review gates the site visit', () => {
  it('moves a listing to site verification once the last document clears', async () => {
    repository.findDocument.mockResolvedValue({ id: 'doc-1', listingId: 'lst-1' });
    repository.reviewDocument.mockResolvedValue({ id: 'doc-1', status: 'VERIFIED' });
    repository.documentsCleared.mockResolvedValue(true);
    repository.findListing.mockResolvedValue(listing({ status: 'AWAITING_DOCUMENTS' }));

    await reviewDocument({ documentId: 'doc-1', approve: true, reviewedByUserId: 'usr-1' });

    expect(repository.setListingStatus).toHaveBeenCalledWith('lst-1', 'AWAITING_SITE_VERIFICATION');
  });

  it('sends a listing back when a document is later rejected', async () => {
    repository.findDocument.mockResolvedValue({ id: 'doc-1', listingId: 'lst-1' });
    repository.reviewDocument.mockResolvedValue({ id: 'doc-1', status: 'REJECTED' });
    repository.documentsCleared.mockResolvedValue(false);
    repository.findListing.mockResolvedValue(listing({ status: 'AWAITING_SITE_VERIFICATION' }));

    await reviewDocument({
      documentId: 'doc-1',
      approve: false,
      rejectionReason: 'Image unreadable',
      reviewedByUserId: 'usr-1',
    });

    expect(repository.setListingStatus).toHaveBeenCalledWith('lst-1', 'AWAITING_DOCUMENTS');
  });

  it('requires a reason on rejection so the publisher can act on it', async () => {
    repository.findDocument.mockResolvedValue({ id: 'doc-1', listingId: 'lst-1' });

    await expect(
      reviewDocument({ documentId: 'doc-1', approve: false, reviewedByUserId: 'usr-1' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('accepting a verification', () => {
  it('publishes the listing and sets the next due date from its cadence', async () => {
    repository.findVerification.mockResolvedValue({ id: 'ver-1', listingId: 'lst-1' });
    repository.reviewVerification.mockResolvedValue({ id: 'ver-1', status: 'ACCEPTED' });
    repository.findListing.mockResolvedValue(listing({ status: 'AWAITING_SITE_VERIFICATION' }));
    repository.findOpenCaseForListing.mockResolvedValue(null);

    await reviewVerification({ verificationId: 'ver-1', approve: true, reviewedByUserId: 'usr-1' });

    const [, dates] = repository.markListingVerified.mock.calls[0] as [string, { verifiedAt: Date; verificationExpiresAt: Date }];
    const days = Math.round(
      (dates.verificationExpiresAt.getTime() - dates.verifiedAt.getTime()) / DAY,
    );
    expect(days).toBe(CADENCE_DAYS.PERMANENT);
    expect(repository.setListingStatus).toHaveBeenCalledWith('lst-1', 'ACTIVE');
    expect(repository.releaseHolds).toHaveBeenCalledWith('lst-1');
  });

  it('lifts a suspension and resolves the open compliance case', async () => {
    repository.findVerification.mockResolvedValue({ id: 'ver-1', listingId: 'lst-1' });
    repository.reviewVerification.mockResolvedValue({ id: 'ver-1', status: 'ACCEPTED' });
    repository.findListing.mockResolvedValue(listing({ status: 'SUSPENDED' }));
    repository.findOpenCaseForListing.mockResolvedValue({ id: 'case-1' });

    await reviewVerification({ verificationId: 'ver-1', approve: true, reviewedByUserId: 'usr-1' });

    expect(repository.setListingStatus).toHaveBeenCalledWith('lst-1', 'ACTIVE');
    expect(repository.setCaseStatus).toHaveBeenCalledWith('case-1', 'RESOLVED');
  });

  it('uses the shorter cadence for a removable spot', async () => {
    repository.findVerification.mockResolvedValue({ id: 'ver-1', listingId: 'lst-1' });
    repository.reviewVerification.mockResolvedValue({ id: 'ver-1', status: 'ACCEPTED' });
    repository.findListing.mockResolvedValue(
      listing({ status: 'AWAITING_SITE_VERIFICATION', removability: 'REMOVABLE' }),
    );
    repository.findOpenCaseForListing.mockResolvedValue(null);

    await reviewVerification({ verificationId: 'ver-1', approve: true, reviewedByUserId: 'usr-1' });

    const [, dates] = repository.markListingVerified.mock.calls[0] as [string, { verifiedAt: Date; verificationExpiresAt: Date }];
    expect(
      Math.round((dates.verificationExpiresAt.getTime() - dates.verifiedAt.getTime()) / DAY),
    ).toBe(CADENCE_DAYS.REMOVABLE);
  });

  it('leaves the listing alone when the verification is rejected', async () => {
    repository.findVerification.mockResolvedValue({ id: 'ver-1', listingId: 'lst-1' });
    repository.reviewVerification.mockResolvedValue({ id: 'ver-1', status: 'REJECTED' });

    await reviewVerification({
      verificationId: 'ver-1',
      approve: false,
      rejectionReason: 'Photo does not show the structure',
      reviewedByUserId: 'usr-1',
    });

    expect(repository.markListingVerified).not.toHaveBeenCalled();
    expect(repository.setListingStatus).not.toHaveBeenCalled();
  });
});

describe('enforcement sweep', () => {
  const due = (over: Record<string, unknown> = {}) => ({
    listingId: 'lst-1',
    title: 'MG Road Billboard',
    publisherId: 'pub-1',
    publisherName: 'Sharma Hoardings',
    removability: 'PERMANENT' as const,
    verifiedAt: null,
    verificationExpiresAt: new Date(NOW.getTime() - DAY),
    status: 'ACTIVE' as const,
    ...over,
  });

  it('opens a hold as soon as a listing lapses, but no case yet', async () => {
    repository.verificationsDue.mockResolvedValue([due()]);
    repository.listingIdsWithOpenCase.mockResolvedValue([]);
    repository.openHolds.mockResolvedValue(1);
    repository.casesPastDue.mockResolvedValue([]);

    const result = await runEnforcementSweep(NOW);

    expect(result.holdsOpened).toBe(1);
    expect(result.casesOpened).toBe(0);
    const [rows] = repository.openHolds.mock.calls[0] as [{ convertsAt: Date }[]];
    // The hold converts 24 hours after expiry, not 24 hours after the sweep, so
    // a sweep that runs late cannot extend the grace period.
    expect(rows[0]!.convertsAt.getTime()).toBe(NOW.getTime() - DAY + 24 * 60 * 60 * 1000);
  });

  it('opens holds and cases in one batched call each, not one per listing', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      due({ listingId: `lst-${i}`, verificationExpiresAt: new Date(NOW.getTime() - 4 * DAY) }),
    );
    repository.verificationsDue.mockResolvedValue(many);
    repository.listingIdsWithOpenCase.mockResolvedValue([]);
    repository.openHolds.mockResolvedValue(25);
    repository.openComplianceCases.mockResolvedValue(25);
    repository.casesPastDue.mockResolvedValue([]);

    await runEnforcementSweep(NOW);

    expect(repository.openHolds).toHaveBeenCalledTimes(1);
    expect(repository.openComplianceCases).toHaveBeenCalledTimes(1);
    expect(repository.listingIdsWithOpenCase).toHaveBeenCalledTimes(1);
  });

  it('opens a compliance case once three days have passed', async () => {
    repository.verificationsDue.mockResolvedValue([
      due({ verificationExpiresAt: new Date(NOW.getTime() - 4 * DAY) }),
    ]);
    repository.listingIdsWithOpenCase.mockResolvedValue([]);
    repository.openHolds.mockResolvedValue(1);
    repository.openComplianceCases.mockResolvedValue(1);
    repository.casesPastDue.mockResolvedValue([]);

    const result = await runEnforcementSweep(NOW);

    expect(result.casesOpened).toBe(1);
  });

  it('does not open a second case for a listing that already has one', async () => {
    repository.verificationsDue.mockResolvedValue([
      due({ verificationExpiresAt: new Date(NOW.getTime() - 4 * DAY) }),
    ]);
    repository.listingIdsWithOpenCase.mockResolvedValue(['lst-1']);
    repository.openHolds.mockResolvedValue(1);
    repository.casesPastDue.mockResolvedValue([]);

    const result = await runEnforcementSweep(NOW);

    expect(result.casesOpened).toBe(0);
    expect(repository.openComplianceCases).not.toHaveBeenCalled();
  });

  it('suspends the listing when the compliance window runs out', async () => {
    repository.verificationsDue.mockResolvedValue([]);
    repository.casesPastDue.mockResolvedValue([{ id: 'case-1', listingId: 'lst-1' }]);
    repository.suspendForCases.mockResolvedValue(1);

    const result = await runEnforcementSweep(NOW);

    expect(result.suspended).toBe(1);
    // Suspension and escalation go together in one transaction, so a partial
    // failure cannot leave a listing suspended with its case still counting down.
    expect(repository.suspendForCases).toHaveBeenCalledWith([
      { id: 'case-1', listingId: 'lst-1' },
    ]);
  });

  it('ignores listings that are not live', async () => {
    repository.verificationsDue.mockResolvedValue([due({ status: 'SUSPENDED' })]);
    repository.listingIdsWithOpenCase.mockResolvedValue([]);
    repository.casesPastDue.mockResolvedValue([]);

    const result = await runEnforcementSweep(NOW);

    expect(result.lapsed).toBe(0);
    expect(repository.openHolds).not.toHaveBeenCalled();
  });
});

describe('claims', () => {
  it('only accepts a claim on an unclaimed listing', async () => {
    repository.findListing.mockResolvedValue(listing({ status: 'ACTIVE' }));

    await expect(
      claimListing({ listingId: 'lst-1', claimantPublisherId: 'pub-2' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('moves an approved listing into a fresh attempt awaiting acceptance', async () => {
    repository.findClaim.mockResolvedValue({
      id: 'clm-1',
      listingId: 'lst-1',
      claimantPublisherId: 'pub-2',
      status: 'PENDING',
    });
    repository.decideClaim.mockResolvedValue({ id: 'clm-1', status: 'APPROVED' });
    repository.createAttempt.mockResolvedValue({ id: 'att-new' });

    await decideClaim({ claimId: 'clm-1', approve: true, decidedByUserId: 'usr-1' });

    expect(repository.assignListingOwner).toHaveBeenCalledWith('lst-1', 'pub-2', 'att-new');
    expect(repository.setAttemptStatus).toHaveBeenCalledWith('att-new', 'AWAITING_ACCEPTANCE');
  });

  it('does not transfer anything when a claim is rejected', async () => {
    repository.findClaim.mockResolvedValue({
      id: 'clm-1',
      listingId: 'lst-1',
      claimantPublisherId: 'pub-2',
      status: 'PENDING',
    });
    repository.decideClaim.mockResolvedValue({ id: 'clm-1', status: 'REJECTED' });

    await decideClaim({
      claimId: 'clm-1',
      approve: false,
      decisionNote: 'Ownership evidence did not match',
      decidedByUserId: 'usr-1',
    });

    expect(repository.assignListingOwner).not.toHaveBeenCalled();
  });

  it('refuses to decide a claim twice', async () => {
    repository.findClaim.mockResolvedValue({ id: 'clm-1', status: 'APPROVED' });

    await expect(
      decideClaim({ claimId: 'clm-1', approve: true, decidedByUserId: 'usr-1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('policy constants match the specification', () => {
  it('holds the agreed cadences and risk windows', () => {
    expect(CADENCE_DAYS).toEqual({ PERMANENT: 180, REMOVABLE: 90 });
    expect(RISK_WINDOW_DAYS).toEqual({ PERMANENT: 15, REMOVABLE: 7 });
  });
});
