import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The check-in, and the flag the whole submit gate hangs on.
 *
 * `fulfilment.test.ts` proves the gate refuses a job that has not been checked
 * in to — by mocking `verification.qrScanned` true or false. That is exactly
 * how this survived: nothing in the codebase ever wrote it. The check-in
 * recorded a CheckIn row and stopped, so the flag was false on every order that
 * has ever existed, `canSubmit` was false with it, and SUBMIT INSTALLATION came
 * back EVIDENCE_INCOMPLETE for an agent who had done every part of the job.
 *
 * So this tests the write rather than the gate: the two halves are only a
 * closed loop if somebody checks they meet.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findWithPublisher: vi.fn(),
    upsertCheckIn: vi.fn(),
    upsertVerification: vi.fn(),
    update: vi.fn(),
    findAgentLocation: vi.fn(),
    findSummary: vi.fn(),
  },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
// A signed SITE/ORDER code is the other proof; the string tests use the listing's own token.
const { qr } = vi.hoisted(() => ({ qr: { isSignedCodeFor: vi.fn() } }));
vi.mock('../../qr', () => qr);

import { agentCheckIn, agentUpdateLocation, updateAgentLocation } from '../tracking/tracking.service';

const AGENT = 'agt_1';
const QR = 'qr_listing_token';

const booking = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  status: 'IN_PROGRESS',
  agentId: AGENT,
  listing: {
    id: 'lst_1',
    title: 'Reception mirror',
    qrToken: QR,
    latitude: 12.9716,
    longitude: 77.5946,
    agentCanInstall: true,
    publisher: { id: 'pub_1', userId: 'usr_pub', address: null, city: null, state: null },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithPublisher.mockResolvedValue(booking());
  repository.upsertCheckIn.mockResolvedValue({ id: 'chk_1' });
  repository.upsertVerification.mockResolvedValue({});
  repository.update.mockResolvedValue({});
  repository.findSummary.mockResolvedValue({ id: 'ord_1', status: 'SLOT_CONFIRMED', agentId: AGENT, listingId: 'lst_1' });
});

describe('checking in at the site', () => {
  /* The missing write. Without it the submit gate can never open. */
  it('records the scan on the verification the submit gate reads', async () => {
    await agentCheckIn('ord_1', AGENT, { latitude: 12.9716, longitude: 77.5946, qrToken: QR });
    expect(repository.upsertVerification).toHaveBeenCalledWith('ord_1', { qrScanned: true });
  });

  it('still records where the agent was standing', async () => {
    await agentCheckIn('ord_1', AGENT, { latitude: 12.9726, longitude: 77.5946, qrToken: QR });
    expect(repository.upsertCheckIn).toHaveBeenCalledWith(
      'ord_1',
      expect.objectContaining({ latitude: 12.9726, longitude: 77.5946 }),
    );
    // Roughly 111 m north. Recorded, never enforced — a bad fix must not block
    // an agent who is standing at the spot.
    const [, patch] = repository.upsertCheckIn.mock.calls[0] as [string, { distanceM: number }];
    expect(patch.distanceM).toBeGreaterThan(80);
    expect(patch.distanceM).toBeLessThan(150);
  });

  /* A scan that did not happen must not be recorded as one. */
  it('accepts a signed site code that resolves to this listing', async () => {
    qr.isSignedCodeFor.mockResolvedValueOnce(true);
    await agentCheckIn('ord_1', AGENT, { latitude: 12.9716, longitude: 77.5946, qrToken: 'signed.site.code' });
    expect(qr.isSignedCodeFor).toHaveBeenCalledWith('signed.site.code', expect.objectContaining({ orderId: 'ord_1' }));
    expect(repository.upsertVerification).toHaveBeenCalledWith('ord_1', { qrScanned: true });
  });

  it('records nothing when the code belongs to another listing', async () => {
    qr.isSignedCodeFor.mockResolvedValueOnce(false);
    await expect(
      agentCheckIn('ord_1', AGENT, { latitude: 12.97, longitude: 77.59, qrToken: 'someone_elses' }),
    ).rejects.toThrow(/QR code does not match/);
    expect(repository.upsertVerification).not.toHaveBeenCalled();
    expect(repository.upsertCheckIn).not.toHaveBeenCalled();
  });

  it('records nothing for an agent the job is not assigned to', async () => {
    await expect(
      agentCheckIn('ord_1', 'agt_someone_else', { latitude: 12.97, longitude: 77.59, qrToken: QR }),
    ).rejects.toThrow(/do not have access/);
    expect(repository.upsertVerification).not.toHaveBeenCalled();
  });

  /** A listing with no coordinates yields distance 0 by design, not an error. */
  it('checks in against a listing that has never been geocoded', async () => {
    repository.findWithPublisher.mockResolvedValue(
      booking({
        listing: { ...booking().listing, latitude: null, longitude: null },
      }),
    );
    await agentCheckIn('ord_1', AGENT, { latitude: 12.97, longitude: 77.59, qrToken: QR });
    const [, patch] = repository.upsertCheckIn.mock.calls[0] as [string, { distanceM: number }];
    expect(patch.distanceM).toBe(0);
    expect(repository.upsertVerification).toHaveBeenCalledWith('ord_1', { qrScanned: true });
  });
});

describe('sharing a position while travelling', () => {
  /**
   * The agent app pings this on a timer the whole way to the site, which is why
   * it does no ownership check: the route guard is the gate, and a lookup per
   * ping would be a query a minute per agent on the road for nothing.
   */
  it('writes the position and the moment it was taken', async () => {
    await updateAgentLocation('ord_1', { latitude: 12.95, longitude: 77.6 });
    expect(repository.update).toHaveBeenCalledWith('ord_1', {
      agentLatitude: 12.95,
      agentLongitude: 77.6,
      agentLocationUpdatedAt: expect.any(Date),
    });
  });
});

/**
 * Lot H (the G12 verifier's gap): the route used to write whoever's position
 * onto whatever order was named. The ping now belongs to the order's own
 * agent, the same rule the milestone route applies.
 */
describe("the position ping is the assigned agent's", () => {
  it('writes for the agent the order is assigned to', async () => {
    await agentUpdateLocation('ord_1', AGENT, { latitude: 12.95, longitude: 77.6 });
    expect(repository.findSummary).toHaveBeenCalledWith('ord_1');
    expect(repository.update).toHaveBeenCalledWith('ord_1', expect.objectContaining({ agentLatitude: 12.95, agentLongitude: 77.6 }));
  });

  it('refuses 403 for any other agent, and writes nothing', async () => {
    await expect(agentUpdateLocation('ord_1', 'agt_someone_else', { latitude: 12.95, longitude: 77.6 })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses 403 for an order with no agent yet', async () => {
    repository.findSummary.mockResolvedValue({ id: 'ord_1', status: 'PENDING_AGENT', agentId: null, listingId: 'lst_1' });
    await expect(agentUpdateLocation('ord_1', AGENT, { latitude: 12.95, longitude: 77.6 })).rejects.toMatchObject({ statusCode: 403 });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('is 404 for an order that does not exist', async () => {
    repository.findSummary.mockResolvedValue(null);
    await expect(agentUpdateLocation('ord_missing', AGENT, { latitude: 12.95, longitude: 77.6 })).rejects.toMatchObject({ statusCode: 404 });
  });
});
