import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A (Q31): `listings.autoPublishOnVerification`.
 *
 * On — the shipped default — an accepted first site visit publishes the
 * listing, as it always has. Off, the listing stays exactly where it was,
 * AWAITING_SITE_VERIFICATION, and the desk is told there is something to
 * look at; no new status is invented for the waiting room, because a status
 * nobody else knows about is a listing that falls out of every count.
 *
 * A re-verification lifting a suspension is not behind the switch: that
 * listing was already published once, and a market that wants a human eye on
 * new inventory did not ask to re-approve inventory it had already approved.
 */

const { repository, settings, notifications, users, pricing } = vi.hoisted(() => ({
  repository: {
    findVerification: vi.fn(),
    reviewVerification: vi.fn(),
    findListing: vi.fn(),
    markListingVerified: vi.fn(),
    releaseHolds: vi.fn(),
    findOpenCaseForListing: vi.fn(),
    setCaseStatus: vi.fn(),
    setListingStatus: vi.fn(),
  },
  settings: { getPlatformSettings: vi.fn() },
  notifications: { createNotification: vi.fn() },
  users: { listAdminUserIds: vi.fn() },
  pricing: { citySupport: vi.fn() },
}));

vi.mock('../prisma-supply.repository', () => ({ prismaSupplyRepository: repository }));
vi.mock('../../app-config', () => settings);
vi.mock('../../notifications', () => notifications);
vi.mock('../../users', () => users);
vi.mock('../../pricing', () => ({
  buildCityResolver: vi.fn(),
  checkSpotVocabulary: vi.fn(),
  classifySpot: vi.fn(),
  citySupport: pricing.citySupport,
  listCities: vi.fn(),
  strongestSurgeFor: vi.fn(),
  surgeWindowsAt: vi.fn(),
}));

import { reviewVerification } from '../supply.service';

const listing = (status: string, city = 'Bengaluru') => ({
  id: 'lst-1',
  title: 'MG Road Billboard',
  city,
  status,
  removability: 'PERMANENT',
});

const OPEN = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
/** Lot V: a launched city publishes; a seeding one gathers but does not; a town the catalogue lacks is free text. */
const cityView = (name: string) =>
  name === 'Mysuru'
    ? { support: 'ACTIVE', resolved: true, stage: 'SEEDING', switches: { ...OPEN, publishing: false, demand: false, printPartners: false }, city: { slug: 'mysuru', name } }
    : name === 'Bengaluru'
      ? { support: 'ACTIVE', resolved: true, stage: 'LAUNCHED', switches: OPEN, city: { slug: 'bengaluru', name } }
      : { support: 'UNKNOWN', resolved: false, stage: null, switches: OPEN, city: null };

beforeEach(() => {
  vi.clearAllMocks();
  settings.getPlatformSettings.mockResolvedValue({ listings: { autoPublishOnVerification: true } });
  users.listAdminUserIds.mockResolvedValue(['admin-1', 'admin-2']);
  repository.findVerification.mockResolvedValue({ id: 'ver-1', listingId: 'lst-1' });
  repository.reviewVerification.mockResolvedValue({ id: 'ver-1', status: 'ACCEPTED' });
  repository.findOpenCaseForListing.mockResolvedValue(null);
  repository.findListing.mockResolvedValue(listing('AWAITING_SITE_VERIFICATION'));
  pricing.citySupport.mockImplementation(async (name: string) => cityView(name));
});

const accept = () =>
  reviewVerification({ verificationId: 'ver-1', approve: true, reviewedByUserId: 'usr-1' });

describe('with auto-publish on', () => {
  it('publishes the listing, as it always has', async () => {
    await accept();
    expect(repository.setListingStatus).toHaveBeenCalledWith('lst-1', 'ACTIVE');
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('publishes in a town the catalogue lacks — free text stays free', async () => {
    repository.findListing.mockResolvedValue(listing('AWAITING_SITE_VERIFICATION', 'Rameswaram'));
    await accept();
    expect(repository.setListingStatus).toHaveBeenCalledWith('lst-1', 'ACTIVE');
  });

  // Lot V: a SEEDING city gathers and verifies but publishes nothing.
  it('holds the listing and tells the desk when the city is not publishing yet', async () => {
    repository.findListing.mockResolvedValue(listing('AWAITING_SITE_VERIFICATION', 'Mysuru'));
    await accept();
    expect(repository.setListingStatus).not.toHaveBeenCalled();
    expect(repository.markListingVerified).toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
  });

  it('keeps a suspended listing suspended when its city is not publishing', async () => {
    repository.findListing.mockResolvedValue(listing('SUSPENDED', 'Mysuru'));
    await accept();
    expect(repository.setListingStatus).not.toHaveBeenCalled();
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
  });
});

describe('with auto-publish off', () => {
  beforeEach(() => {
    settings.getPlatformSettings.mockResolvedValue({ listings: { autoPublishOnVerification: false } });
  });

  it('leaves the listing where it was and tells the desk', async () => {
    await accept();

    expect(repository.setListingStatus).not.toHaveBeenCalled();
    // Still verified and still on the clock: the visit happened.
    expect(repository.markListingVerified).toHaveBeenCalled();

    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        title: 'Verified — waiting for a human look',
        subtitle: 'MG Road Billboard',
        relatedId: 'lst-1',
      }),
    );
  });

  it('still lifts a suspension on a re-verification', async () => {
    repository.findListing.mockResolvedValue(listing('SUSPENDED'));
    await accept();
    expect(repository.setListingStatus).toHaveBeenCalledWith('lst-1', 'ACTIVE');
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('does not undo an accepted verification when the desk cannot be told', async () => {
    users.listAdminUserIds.mockRejectedValue(new Error('notifications are down'));
    await expect(accept()).resolves.toMatchObject({ status: 'ACCEPTED' });
    expect(repository.setListingStatus).not.toHaveBeenCalled();
  });

  it('leaves a listing still waiting on its documents alone, switch or no switch', async () => {
    repository.findListing.mockResolvedValue(listing('AWAITING_DOCUMENTS'));
    await accept();
    expect(repository.setListingStatus).not.toHaveBeenCalled();
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});
