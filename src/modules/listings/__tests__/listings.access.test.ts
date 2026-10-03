import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may change a listing.
 *
 * There was no check at all: `PATCH /listings/:id` was gated on the role
 * `AGENT_PUBLISHER` and nothing compared the caller to the listing. Any agent
 * account could edit any listing — and because listings are read live as
 * comparables, repricing someone else's spot moves the range every neighbour in
 * that 200 m circle is measured against. Not a data-integrity bug: a way to
 * move a market from an ordinary field account.
 */

const repository = vi.hoisted(() => ({
  findWithPublisher: vi.fn(),
  findPublisherById: vi.fn(),
  // VH-3: the caller's own publisher record, for the pre-listing check.
  findPublisherByUserId: vi.fn(),
}));
const findAgentProfile = vi.hoisted(() => vi.fn());
const holdsLiveGrant = vi.hoisted(() => vi.fn());
const lookupVehicleRc = vi.hoisted(() => vi.fn(async () => ({ ok: false, code: 'UNCONFIGURED', message: 'Cashfree verification is not configured' })));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../agents', () => ({ findAgentProfile, findWorkingAgentProfile: findAgentProfile }));
vi.mock('../../access-grants', () => ({ holdsLiveGrant }));
vi.mock('../../pricing', () => ({ classifySpot: vi.fn(), activeSurge: vi.fn() }));
/* VH-1: the vendor behind the RC check. Unconfigured here, so a call that
   gets past the guard fails at the vendor with a 409 — which is exactly how
   these tests tell "refused at the door" from "reached the lookup". */
vi.mock('../../../shared/integrations', () => ({
  nameMatchScore: vi.fn(() => null),
  normaliseVehicleNumber: (value: string) => value.toUpperCase().replace(/\s+/g, ''),
}));
// Cashfree Phase 1: the RC check goes through the verification router; the vendor's answer is mocked at that door.
vi.mock('../../../shared/verification', () => ({ routedVehicleRc: lookupVehicleRc }));

import { assertCanCreateForPublisher, assertCanEditListing, checkVehicleRcForPublisher, verifyListingVehicleRc } from '../listings.service';

const OWNER = { userId: 'usr_publisher', isAdmin: false };
const STRANGER = { userId: 'usr_other_agent', isAdmin: false };

const listing = (overrides: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  publisher: { id: 'pub_1', userId: 'usr_publisher', agentId: 'agt_theirs' },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithPublisher.mockResolvedValue(listing());
  findAgentProfile.mockResolvedValue(null);
  holdsLiveGrant.mockResolvedValue(false);
});

describe('who may edit a listing', () => {
  it('lets ADX through without even reading the listing', async () => {
    await expect(
      assertCanEditListing('lst_1', { userId: 'usr_ops', isAdmin: true })
    ).resolves.toBeUndefined();
    expect(repository.findWithPublisher).not.toHaveBeenCalled();
  });

  it('lets the publisher edit their own', async () => {
    await expect(assertCanEditListing('lst_1', OWNER)).resolves.toBeUndefined();
  });

  /**
   * `Publisher.agentId`, not `Listing.agentId`. A publisher who has moved to
   * another agent has moved; the agent who happened to key the listing in last
   * year has not kept a claim on it.
   */
  it('lets the agent who onboarded that publisher edit it', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_theirs' });
    await expect(assertCanEditListing('lst_1', STRANGER)).resolves.toBeUndefined();
    expect(holdsLiveGrant).not.toHaveBeenCalled();
  });

  it('refuses an agent with no relationship to the publisher', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_someone_else' });
    await expect(assertCanEditListing('lst_1', STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('refuses a signed-in user who is not an agent at all', async () => {
    await expect(assertCanEditListing('lst_1', STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('lets an agent through on a live delegated grant', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_someone_else' });
    holdsLiveGrant.mockResolvedValue(true);
    await expect(assertCanEditListing('lst_1', STRANGER)).resolves.toBeUndefined();
    // Narrowed to this listing, so a grant naming three others does not cover it.
    expect(holdsLiveGrant).toHaveBeenCalledWith('agt_someone_else', 'pub_1', 'LISTINGS', 'lst_1');
  });

  /** A scraped listing belongs to nobody yet, so it belongs to ADX. */
  it('refuses everyone but ADX on an unclaimed listing', async () => {
    repository.findWithPublisher.mockResolvedValue(listing({ publisher: null }));
    findAgentProfile.mockResolvedValue({ id: 'agt_theirs' });
    await expect(assertCanEditListing('lst_1', STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('answers 404 for a listing that does not exist', async () => {
    repository.findWithPublisher.mockResolvedValue(null);
    await expect(assertCanEditListing('lst_missing', OWNER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

/**
 * The same question, one verb earlier.
 *
 * `POST /listings` took a `publisherId` from the body and asked nothing about
 * it, so any agent-publisher account could file a listing — at a price of their
 * choosing — under somebody else's name. That price then enters the comparable
 * pool for every spot within 200 m, so the damage is not confined to the account
 * it was filed against.
 */
describe('who may add a spot to a publisher', () => {
  beforeEach(() => {
    repository.findPublisherById.mockResolvedValue({
      id: 'pub_1',
      userId: 'usr_publisher',
      agentId: 'agt_theirs',
    });
  });

  it('lets ADX through without reading the publisher', async () => {
    await expect(
      assertCanCreateForPublisher('pub_1', { userId: 'usr_ops', isAdmin: true })
    ).resolves.toBeUndefined();
    expect(repository.findPublisherById).not.toHaveBeenCalled();
  });

  it('lets the agent who onboarded that publisher add one', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_theirs' });
    await expect(assertCanCreateForPublisher('pub_1', STRANGER)).resolves.toBeUndefined();
    expect(holdsLiveGrant).not.toHaveBeenCalled();
  });

  it('refuses an agent with no relationship to the publisher', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_someone_else' });
    await expect(assertCanCreateForPublisher('pub_1', STRANGER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('BL-1: lets the publisher add to their own account (the website bulk upload)', async () => {
    await expect(assertCanCreateForPublisher('pub_1', { userId: 'usr_publisher', isAdmin: false })).resolves.toBeUndefined();
    expect(findAgentProfile).not.toHaveBeenCalled();
  });

  /** "Help me with my listings" covers adding one, and only for that publisher. */
  it('lets an agent through on a live delegated grant', async () => {
    findAgentProfile.mockResolvedValue({ id: 'agt_someone_else' });
    holdsLiveGrant.mockResolvedValue(true);
    await expect(assertCanCreateForPublisher('pub_1', STRANGER)).resolves.toBeUndefined();
    expect(holdsLiveGrant).toHaveBeenCalledWith('agt_someone_else', 'pub_1', 'LISTINGS');
  });

  it('answers 404 for a publisher that does not exist', async () => {
    repository.findPublisherById.mockResolvedValue(null);
    await expect(assertCanCreateForPublisher('pub_missing', STRANGER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

/**
 * VH-1: the vehicle check is a verification, not a lookup service.
 *
 * An RC answer carries the owner's name and address, so who may run one is
 * the whole point. The desk may; so may the spot's own publisher and the
 * agent registering it, because that is where the number is typed. Anybody
 * else is refused BEFORE the lookup runs — a stranger must not be able to
 * turn a registration number they read off a parked auto into a name and an
 * address through our door.
 */
describe("who may check a vehicle spot's RC", () => {
    it("refuses a stranger before the lookup is even attempted", async () => {
        await expect(verifyListingVehicleRc("lst_1", {}, STRANGER.userId, STRANGER)).rejects.toMatchObject({ statusCode: 403 });
        expect(lookupVehicleRc).not.toHaveBeenCalled();
    });

    it("lets the spot's own publisher run it", async () => {
        // Past the guard, so it reaches the vendor — unconfigured here, which is the 409.
        await expect(verifyListingVehicleRc("lst_1", { vehicleNumber: "KA01AB1234" }, OWNER.userId, OWNER)).rejects.toMatchObject({ statusCode: 409 });
        expect(lookupVehicleRc).toHaveBeenCalledWith("KA01AB1234", { caseType: "LISTING", caseId: "lst_1" });
    });

    it("lets the agent who holds that publisher run it", async () => {
        findAgentProfile.mockResolvedValue({ id: "agt_theirs" });
        await expect(
            verifyListingVehicleRc("lst_1", { vehicleNumber: "KA01AB1234" }, "usr_their_agent", { userId: "usr_their_agent", isAdmin: false }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(lookupVehicleRc).toHaveBeenCalled();
    });

    it("still lets the desk run it, which is how AG-4 shipped", async () => {
        await expect(verifyListingVehicleRc("lst_1", { vehicleNumber: "KA01AB1234" }, "usr_admin", { userId: "usr_admin", isAdmin: true })).rejects.toMatchObject({
            statusCode: 409,
        });
        expect(lookupVehicleRc).toHaveBeenCalled();
    });
});


/**
 * VH-3 — the Verify button while the spot is still being registered.
 *
 * At that moment there is no listing, so the listing-scoped check has
 * nothing to be called with. This route answers the one question that
 * matters then — is this the publisher's own vehicle — and answers LESS than
 * the listing check does: nothing is stored, and the registered owner's name
 * never comes back, only how closely it matches. A route that returned the
 * owner of any number anybody typed would be a people-finder with a Verify
 * button on it.
 */
describe("checking a vehicle before the listing exists", () => {
  const RC = {
    ok: true as const,
    facts: {
      registrationNumber: "KA01AB1234",
      ownerName: "Ramesh Kumar",
      presentAddress: "12 4th Cross, Bengaluru",
      fatherName: "Suresh Kumar",
      maker: "Bajaj",
      model: "RE",
      vehicleClass: "Three Wheeler (Passenger)",
      rcStatus: "ACTIVE",
      blacklisted: false,
      insuranceValidUntil: "2027-03-31",
      fitnessValidUntil: "2028-01-31",
      pucValidUntil: "2026-12-31",
    },
    raw: {},
  };

  beforeEach(() => {
    repository.findPublisherByUserId.mockResolvedValue({ id: "pub_1", name: "Ramesh Kumar" });
  });

  it("measures the RC against the caller's own publisher record when none is named", async () => {
    lookupVehicleRc.mockResolvedValue(RC as never);
    const answer = await checkVehicleRcForPublisher({ vehicleNumber: "ka 01 ab 1234" }, OWNER);
    expect(lookupVehicleRc).toHaveBeenCalledWith("KA01AB1234", { caseType: "LISTING", caseId: "publisher:pub_1" });
    expect(answer.vehicleNumber).toBe("KA01AB1234");
    expect(answer.publisherName).toBe("Ramesh Kumar");
  });

  it("never returns the registered owner, their address or their father's name", async () => {
    lookupVehicleRc.mockResolvedValue(RC as never);
    const answer = await checkVehicleRcForPublisher({ vehicleNumber: "KA01AB1234" }, OWNER);
    const printed = JSON.stringify(answer);
    expect(printed).not.toContain("12 4th Cross");
    expect(printed).not.toContain("Suresh Kumar");
    /* The publisher's OWN name comes back, because the screen prints "matched
       against you" — what must not come back is the register's answer to
       "who owns this", which is the whole privacy line. */
    expect(answer).not.toHaveProperty("ownerName");
    expect(answer.vehicle).toEqual({
      maker: "Bajaj",
      model: "RE",
      vehicleClass: "Three Wheeler (Passenger)",
      rcStatus: "ACTIVE",
      blacklisted: false,
      insuranceValidUntil: "2027-03-31",
      fitnessValidUntil: "2028-01-31",
      pucValidUntil: "2026-12-31",
    });
  });

  it("refuses a stranger naming somebody else's publisher, and never reaches the vendor", async () => {
    repository.findPublisherByUserId.mockResolvedValue(null);
    repository.findPublisherById.mockResolvedValue({ id: "pub_1", agentId: "agt_theirs" });
    findAgentProfile.mockResolvedValue({ id: "agt_mine" });
    holdsLiveGrant.mockResolvedValue(false);
    await expect(checkVehicleRcForPublisher({ vehicleNumber: "KA01AB1234", publisherId: "pub_1" }, STRANGER)).rejects.toMatchObject({ statusCode: 403 });
    expect(lookupVehicleRc).not.toHaveBeenCalled();
  });

  it("lets the agent who onboarded the publisher check it for them", async () => {
    repository.findPublisherByUserId.mockResolvedValue(null);
    repository.findPublisherById.mockResolvedValue({ id: "pub_1", agentId: "agt_theirs", name: "Ramesh Kumar" });
    findAgentProfile.mockResolvedValue({ id: "agt_theirs" });
    lookupVehicleRc.mockResolvedValue(RC as never);
    const answer = await checkVehicleRcForPublisher({ vehicleNumber: "KA01AB1234", publisherId: "pub_1" }, { userId: "usr_their_agent", isAdmin: false });
    expect(answer.publisherName).toBe("Ramesh Kumar");
  });

  it("says the vendor could not answer rather than that the vehicle failed", async () => {
    lookupVehicleRc.mockResolvedValue({ ok: false, code: "UNCONFIGURED", message: "Cashfree verification is not configured" } as never);
    await expect(checkVehicleRcForPublisher({ vehicleNumber: "KA01AB1234" }, OWNER)).rejects.toMatchObject({
      statusCode: 409,
      code: "VERIFICATION_UNAVAILABLE",
      details: { code: "UNCONFIGURED" },
    });
  });
});
