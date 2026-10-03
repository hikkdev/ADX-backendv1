import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /users/me/party — the first question after the first OTP.
 *
 * Register-or-login leaves a new number with an account and no side. This is
 * what gives it one: a publisher or advertiser row, the identifier that row
 * mints, and the role that lets the rest of the API in. What is pinned: the
 * mapping from the three account types the frame asks about onto each side's
 * own legal-form column; that asking twice for a side returns it rather than
 * opening it again; that an account may hold both sides; and what the name
 * falls back to before the profile step supplies one.
 */

const { repository, publishers, advertisers } = vi.hoisted(() => ({
  repository: { findProfile: vi.fn(), grantRole: vi.fn(), updateProfile: vi.fn() },
  publishers: { registerPublisher: vi.fn() },
  advertisers: { registerAdvertiser: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../publishers', () => publishers);
vi.mock('../../advertisers', () => advertisers);
// M-B: access-control registers its console-standing predicate on auth's port at load.
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m, registerConsoleStandingResolver: () => undefined }));

import { chooseParty } from '../users.service';
import { registerPartnerApplicationPort } from '../users.ports';

const user = (over: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  mobile: '+919876543210',
  name: null,
  roles: [],
  agentProfile: null,
  publisherProfile: null,
  advertiserProfile: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findProfile.mockResolvedValue(user());
  repository.grantRole.mockResolvedValue({});
  publishers.registerPublisher.mockResolvedValue({
    publisher: { id: 'pub_1', displayId: 'PUB-1009-2601' },
    created: true,
  });
  advertisers.registerAdvertiser.mockResolvedValue({ id: 'adv_1', displayId: 'ADV-1009-2601' });
});

describe('opening the publisher side', () => {
  it('registers through the publishers module with the account type in its vocabulary, then grants the role', async () => {
    const choice = await chooseParty('usr_1', { party: 'PUBLISHER', accountType: 'BUSINESS' });

    expect(publishers.registerPublisher).toHaveBeenCalledWith('usr_1', { name: undefined, type: 'BUSINESS' });
    expect(repository.grantRole).toHaveBeenCalledWith('usr_1', 'PUBLISHER');
    expect(choice).toEqual({
      party: 'PUBLISHER',
      accountType: 'BUSINESS',
      profileId: 'pub_1',
      displayId: 'PUB-1009-2601',
      created: true,
    });
  });

  it('maps Organisation onto NGO, the closest form the schema has', async () => {
    await chooseParty('usr_1', { party: 'PUBLISHER', accountType: 'ORGANISATION' });
    expect(publishers.registerPublisher).toHaveBeenCalledWith('usr_1', expect.objectContaining({ type: 'NGO' }));
  });

  it('passes a name the caller gave, else the one the account already has', async () => {
    await chooseParty('usr_1', { party: 'PUBLISHER', accountType: 'INDIVIDUAL', name: 'Asha Rao' });
    expect(publishers.registerPublisher).toHaveBeenLastCalledWith('usr_1', expect.objectContaining({ name: 'Asha Rao' }));

    repository.findProfile.mockResolvedValue(user({ name: 'Known Name' }));
    await chooseParty('usr_1', { party: 'PUBLISHER', accountType: 'INDIVIDUAL' });
    expect(publishers.registerPublisher).toHaveBeenLastCalledWith('usr_1', expect.objectContaining({ name: 'Known Name' }));
  });

  it('answers with the existing side rather than opening it twice', async () => {
    repository.findProfile.mockResolvedValue(
      user({ publisherProfile: { id: 'pub_existing', displayId: 'PUB-0109-2601' } }),
    );
    const choice = await chooseParty('usr_1', { party: 'PUBLISHER', accountType: 'INDIVIDUAL' });

    expect(publishers.registerPublisher).not.toHaveBeenCalled();
    expect(repository.grantRole).not.toHaveBeenCalled();
    expect(choice).toMatchObject({ profileId: 'pub_existing', displayId: 'PUB-0109-2601', created: false });
  });

  /* An agent opened the row at the door; the publishers module claims it and says so. */
  it('reports a claimed row as not created, so the route answers 200', async () => {
    publishers.registerPublisher.mockResolvedValue({
      publisher: { id: 'pub_held', displayId: 'PUB-0509-2603' },
      created: false,
    });
    const choice = await chooseParty('usr_1', { party: 'PUBLISHER', accountType: 'INDIVIDUAL' });
    expect(repository.grantRole).toHaveBeenCalledWith('usr_1', 'PUBLISHER');
    expect(choice).toMatchObject({ profileId: 'pub_held', created: false });
  });
});

describe('opening the advertiser side', () => {
  it('registers through the advertisers module in its vocabulary, named by its number until told otherwise', async () => {
    const choice = await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'BUSINESS' });

    // QR-15: the app's own door stamps SELF beside these (pinned in qr15-party-self-stamp).
    expect(advertisers.registerAdvertiser).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'usr_1',
      name: '+919876543210',
      type: 'COMMERCIAL',
    }));
    expect(repository.grantRole).toHaveBeenCalledWith('usr_1', 'ADVERTISER');
    expect(choice).toEqual({
      party: 'ADVERTISER',
      accountType: 'BUSINESS',
      profileId: 'adv_1',
      displayId: 'ADV-1009-2601',
      created: true,
    });
  });

  it('maps Individual and Organisation onto the advertiser forms', async () => {
    await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'INDIVIDUAL' });
    expect(advertisers.registerAdvertiser).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'INDIVIDUAL' }));
    await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'ORGANISATION' });
    expect(advertisers.registerAdvertiser).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'NGO' }));
  });

  it('lets an account that is already a publisher open the advertiser side too', async () => {
    repository.findProfile.mockResolvedValue(
      user({ publisherProfile: { id: 'pub_1', displayId: 'PUB-1009-2601' } }),
    );
    const choice = await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'INDIVIDUAL' });
    expect(advertisers.registerAdvertiser).toHaveBeenCalled();
    expect(choice).toMatchObject({ party: 'ADVERTISER', created: true });
  });

  /*
   * 28 Sep 2026: "Your name" on an individual's side form is the person's
   * own — kept on the account (the publisher door already did), so the
   * basics that follow open with it instead of asking it again. A business
   * name never lands on the person, and a person with a name keeps it.
   */
  it("keeps an individual's name on an account that has none, and never a business name", async () => {
    await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'INDIVIDUAL', name: 'Satya Raj' });
    expect(advertisers.registerAdvertiser).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Satya Raj', type: 'INDIVIDUAL' }));
    expect(repository.updateProfile).toHaveBeenCalledWith('usr_1', { name: 'Satya Raj' });

    repository.updateProfile.mockClear();
    await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'BUSINESS', name: 'Raj Traders' });
    expect(repository.updateProfile).not.toHaveBeenCalled();
    // The business name is the registered name the billing step asks for: carried there too.
    expect(advertisers.registerAdvertiser).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Raj Traders', companyName: 'Raj Traders', type: 'COMMERCIAL' }));

    repository.findProfile.mockResolvedValue(user({ name: 'Satya Raj' }));
    await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'INDIVIDUAL', name: 'S. Raj' });
    expect(repository.updateProfile).not.toHaveBeenCalled();
  });

  it("carries the account's email onto the row it opens (the website proves it before the side)", async () => {
    repository.findProfile.mockResolvedValue(user({ email: 'raj@example.com' }));
    await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'INDIVIDUAL' });
    expect(advertisers.registerAdvertiser).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'raj@example.com' }));
    await chooseParty('usr_1', { party: 'PUBLISHER', accountType: 'BUSINESS', name: 'Acme Outdoor' });
    expect(publishers.registerPublisher).toHaveBeenLastCalledWith('usr_1', expect.objectContaining({ email: 'raj@example.com', name: 'Acme Outdoor' }));
  });

  it('answers with the existing side rather than opening it twice', async () => {
    repository.findProfile.mockResolvedValue(
      user({ advertiserProfile: { id: 'adv_existing', displayId: 'ADV-0109-2601' } }),
    );
    const choice = await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'INDIVIDUAL' });
    expect(advertisers.registerAdvertiser).not.toHaveBeenCalled();
    expect(choice).toMatchObject({ profileId: 'adv_existing', created: false });
  });
});

it('is a 404 for an account that does not exist', async () => {
  repository.findProfile.mockResolvedValue(null);
  await expect(chooseParty('usr_none', { party: 'PUBLISHER', accountType: 'INDIVIDUAL' })).rejects.toMatchObject({
    statusCode: 404,
  });
});

describe('opening a print-partner application (PP-1)', () => {
  it('goes through the port the partner module fills, with the shop named after the number until the form names it', async () => {
    const apply = vi.fn().mockResolvedValue({ partner: { id: 'prt_1', displayId: 'PRT-2109-2601' }, created: true });
    registerPartnerApplicationPort({ apply });
    const choice = await chooseParty('usr_1', { party: 'PRINT_PARTNER', accountType: 'BUSINESS' });
    expect(apply).toHaveBeenCalledWith('usr_1', { name: '+919876543210', legalName: null, mobile: '+919876543210', email: null });
    // The role is the partner module's to grant with the row; this side grants nothing.
    expect(repository.grantRole).not.toHaveBeenCalled();
    expect(choice).toEqual({ party: 'PRINT_PARTNER', accountType: 'BUSINESS', profileId: 'prt_1', displayId: 'PRT-2109-2601', created: true });
  });

  it('is a 503 while nothing fills the port', async () => {
    registerPartnerApplicationPort(null);
    await expect(chooseParty('usr_1', { party: 'PRINT_PARTNER', accountType: 'INDIVIDUAL' })).rejects.toMatchObject({
      statusCode: 503,
      code: 'PARTY_UNAVAILABLE',
    });
  });
});
