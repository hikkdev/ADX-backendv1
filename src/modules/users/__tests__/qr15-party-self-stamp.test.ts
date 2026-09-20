import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-15 (17 Sep 2026) — the app's own door stamps its provenance.
 *
 * `POST /users/me/party` is where an advertiser actually comes into being
 * from the app (the profile gate only fills the row in later), so the SELF
 * stamp QR-14 gave `POST /advertisers` has to be written here too — or
 * every organic advertiser reads "Not recorded" on the console and is
 * missing from the board's organic count.
 */

const { repository, publishers, advertisers } = vi.hoisted(() => ({
  repository: { findProfile: vi.fn(), grantRole: vi.fn() },
  publishers: { registerPublisher: vi.fn() },
  advertisers: { registerAdvertiser: vi.fn() },
}));

vi.mock('../prisma-users.repository', () => ({ prismaUsersRepository: repository }));
vi.mock('../../publishers', () => publishers);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../auth', () => ({ normalizeMobile: (m: string) => m, registerConsoleStandingResolver: () => undefined }));

import { chooseParty } from '../users.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findProfile.mockResolvedValue({
    id: 'usr_1',
    mobile: '+919876543210',
    name: 'Meera Shah',
    roles: [],
    agentProfile: null,
    publisherProfile: null,
    advertiserProfile: null,
  });
  repository.grantRole.mockResolvedValue({});
  advertisers.registerAdvertiser.mockResolvedValue({ id: 'adv_1', displayId: 'ADV-1709-2601' });
});

describe('chooseParty', () => {
  it("stamps the app's own door as SELF on the advertiser it opens", async () => {
    await chooseParty('usr_1', { party: 'ADVERTISER', accountType: 'INDIVIDUAL' });
    const input = advertisers.registerAdvertiser.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ userId: 'usr_1', name: 'Meera Shah', type: 'INDIVIDUAL', onboardedVia: 'SELF', onboardedById: null, onboardedByRole: null });
    expect(input['onboardedAt']).toBeInstanceOf(Date);
  });
});
