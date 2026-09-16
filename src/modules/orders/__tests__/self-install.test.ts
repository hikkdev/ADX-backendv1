import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The publisher installs their own spot.
 *
 * This lane wrote three scalar columns and nothing else, while Proof of Work
 * reads the OrderPhoto rows `fulfilmentEvidence` groups. So a publisher could
 * collect the prints, photograph the spot, install the advertisement,
 * photograph that — and open the screen to be told nothing had been filed
 * against the booking. The check-in was worse: it stamped a date nobody read
 * and left the CHECK_IN requirement outstanding for ever.
 *
 * These tests walk the lane and assert both halves of every step: the row the
 * evidence screens read, and the column the order aggregate carries.
 */

const { repository, notify } = vi.hoisted(() => ({
  repository: {
    findWithPublisher: vi.fn(),
    update: vi.fn(),
    addPhotos: vi.fn(),
    upsertCheckIn: vi.fn(),
    upsertVerification: vi.fn(),
  },
  notify: {
    notifyUser: vi.fn(),
    notifyAdmins: vi.fn(),
    notifyAgent: vi.fn(),
    shortId: (s: string) => s.slice(0, 6),
  },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);

import {
  selfInstallCaptureCondition,
  selfInstallCaptureInstallation,
  selfInstallCheckIn,
  selfInstallCollectPrints,
} from '../fulfilment/self-install.service';

const PUBLISHER_USER = 'usr_pub';
const QR = 'qr_reception_mirror';

const booking = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  status: 'SELF_INSTALL',
  agentId: null,
  installBy: 'PUBLISHER',
  listing: {
    id: 'lst_1',
    title: 'Reception mirror',
    latitude: 19.076,
    longitude: 72.8777,
    qrToken: QR,
    agentCanInstall: true,
    publisher: { id: 'pub_1', userId: PUBLISHER_USER, address: '12 MG Road', city: null, state: null },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithPublisher.mockResolvedValue(booking());
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  repository.addPhotos.mockResolvedValue(1);
  repository.upsertCheckIn.mockResolvedValue({});
  repository.upsertVerification.mockResolvedValue({});
  notify.notifyAdmins.mockResolvedValue(undefined);
});

describe('the publisher’s evidence is filed where the evidence screens read it', () => {
  it('files the collected prints as a PICKUP photograph, and keeps the column', async () => {
    await selfInstallCollectPrints('ord_1', PUBLISHER_USER, 'https://cdn/collect.jpg');
    expect(repository.addPhotos).toHaveBeenCalledWith(
      'ord_1',
      'PICKUP',
      [{ url: 'https://cdn/collect.jpg', label: 'Material collected' }],
      PUBLISHER_USER,
    );
    expect(repository.update).toHaveBeenCalledWith('ord_1', {
      selfInstallCollectPhotoUrl: 'https://cdn/collect.jpg',
    });
  });

  it('files every condition photograph, not only the column', async () => {
    await selfInstallCaptureCondition('ord_1', PUBLISHER_USER, ['a.jpg', 'b.jpg', 'c.jpg']);
    expect(repository.addPhotos).toHaveBeenCalledWith(
      'ord_1',
      'CONDITION',
      [
        { url: 'a.jpg', label: null },
        { url: 'b.jpg', label: null },
        { url: 'c.jpg', label: null },
      ],
      PUBLISHER_USER,
    );
    expect(repository.update).toHaveBeenCalledWith('ord_1', {
      selfInstallConditionPhotoUrls: ['a.jpg', 'b.jpg', 'c.jpg'],
    });
  });

  it('files the finished advertisement under the same label as the agent lane', async () => {
    await selfInstallCaptureInstallation('ord_1', PUBLISHER_USER, 'after.jpg');
    expect(repository.addPhotos).toHaveBeenCalledWith(
      'ord_1',
      'INSTALLATION',
      [{ url: 'after.jpg', label: 'Advertisement in place' }],
      PUBLISHER_USER,
    );
    expect(repository.update).toHaveBeenCalledWith('ord_1', {
      status: 'PENDING_APPROVAL',
      selfInstallInstallPhotoUrl: 'after.jpg',
    });
  });
});

describe('the publisher checks in', () => {
  it('records the scan when the token is the spot’s own', async () => {
    await selfInstallCheckIn('ord_1', PUBLISHER_USER, {
      latitude: 19.076,
      longitude: 72.8777,
      qrToken: QR,
    });
    expect(repository.upsertVerification).toHaveBeenCalledWith('ord_1', { qrScanned: true });
  });

  /* The stamp is what carries CHECK_IN, so a wrong token must not cost it. */
  it('still stamps the check-in when the token does not match, and claims no scan', async () => {
    await selfInstallCheckIn('ord_1', PUBLISHER_USER, {
      latitude: 19.076,
      longitude: 72.8777,
      qrToken: 'lst_1',
    });
    expect(repository.upsertVerification).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith('ord_1', {
      selfInstallCheckedInAt: expect.any(Date),
    });
  });

  /* Recorded, not enforced — the same trade the agent lane makes. */
  it('records how far from the spot the check-in was filed', async () => {
    await selfInstallCheckIn('ord_1', PUBLISHER_USER, { latitude: 19.086, longitude: 72.8777 });
    const checkIn = repository.upsertCheckIn.mock.calls[0]?.[1];
    expect(checkIn.latitude).toBe(19.086);
    expect(Math.round(checkIn.distanceM)).toBeGreaterThan(1000);
    expect(repository.update).toHaveBeenCalledWith('ord_1', {
      selfInstallCheckedInAt: expect.any(Date),
    });
  });

  /* A refused or slow fix must not cost the publisher the check-in. */
  it('checks in with no coordinates at all', async () => {
    await selfInstallCheckIn('ord_1', PUBLISHER_USER, {});
    expect(repository.upsertCheckIn).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith('ord_1', {
      selfInstallCheckedInAt: expect.any(Date),
    });
  });
});

describe('the lane is still the publisher’s alone', () => {
  it('will not file against somebody else’s spot', async () => {
    await expect(
      selfInstallCaptureCondition('ord_1', 'usr_someone_else', ['a.jpg']),
    ).rejects.toThrow('NOT_YOUR_ORDER');
    expect(repository.addPhotos).not.toHaveBeenCalled();
  });

  it('will not file against a booking that is not on this lane', async () => {
    repository.findWithPublisher.mockResolvedValue(booking({ status: 'IN_PROGRESS' }));
    await expect(
      selfInstallCaptureInstallation('ord_1', PUBLISHER_USER, 'after.jpg'),
    ).rejects.toThrow('WRONG_STATUS');
    expect(repository.addPhotos).not.toHaveBeenCalled();
  });
});
