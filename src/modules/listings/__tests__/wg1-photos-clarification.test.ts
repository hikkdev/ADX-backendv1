import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WG-1 (DR 12 boards 08/09) — photographs on a live listing, and the
 * publisher's written word back on a send-back.
 *
 * What is pinned: both are fenced by the edit rule (`assertCanEditListing`);
 * a photograph is written and audited; a photograph of another listing is
 * not found here; a clarification is audited on the listing and every
 * admin is told, the message cut to fit a notification.
 */
const { repository, audit, notifications, deps } = vi.hoisted(() => ({
  repository: { addPhoto: vi.fn(), uploadedPhotoFacts: vi.fn(), findPhoto: vi.fn(), deletePhoto: vi.fn(), findWithPublisher: vi.fn(), adminUserIds: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(), findActivityRows: vi.fn() },
  notifications: { createNotification: vi.fn() },
  deps: { holdsLiveGrant: vi.fn(), findWorkingAgentProfile: vi.fn() },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../notifications', () => notifications);
vi.mock('../../access-grants', () => ({ holdsLiveGrant: deps.holdsLiveGrant }));
vi.mock('../../agents', () => ({ findWorkingAgentProfile: deps.findWorkingAgentProfile }));

import { addListingPhoto, removeListingPhoto, sendListingClarification } from '../listings.service';

const owner = { userId: 'usr_pub', isAdmin: false };
const stranger = { userId: 'usr_other', isAdmin: false };
const listing = { id: 'lst_1', title: 'MG Road display', publisher: { id: 'pub_1', userId: 'usr_pub', agentId: null } };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithPublisher.mockResolvedValue(listing);
  repository.adminUserIds.mockResolvedValue(['usr_admin1', 'usr_admin2']);
  repository.addPhoto.mockImplementation(async (_id: string, data: { url: string; type: string }) => ({ id: 'ph_1', ...data, createdAt: new Date('2026-09-25T00:00:00Z') }));
  repository.deletePhoto.mockResolvedValue({ count: 1 });
  repository.uploadedPhotoFacts.mockResolvedValue([]);
  deps.findWorkingAgentProfile.mockResolvedValue(null);
  deps.holdsLiveGrant.mockResolvedValue(false);
  audit.logActivity.mockResolvedValue(undefined);
  notifications.createNotification.mockResolvedValue({});
});

describe('photographs', () => {
  it('the owner adds one, audited; a stranger is refused', async () => {
    const photo = await addListingPhoto('lst_1', { url: 'https://cdn.adx.in/p.jpg', type: 'main' }, owner);
    expect(repository.addPhoto).toHaveBeenCalledWith('lst_1', { url: 'https://cdn.adx.in/p.jpg', type: 'main', uploadedFileId: null, takenAt: null });
    expect(photo).toMatchObject({ id: 'ph_1', url: 'https://cdn.adx.in/p.jpg' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_pub', 'LISTING_PHOTO_ADDED', expect.objectContaining({ targetId: 'lst_1', metadata: { photoId: 'ph_1', type: 'main' } }));

    await expect(addListingPhoto('lst_1', { url: 'https://cdn.adx.in/p.jpg', type: 'main' }, stranger)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('LD-1: files a photograph with its upload-register row and capture time — matched on the URL when the client did not say', async () => {
    repository.uploadedPhotoFacts.mockResolvedValue([{ id: 'upl_7', url: 'https://cdn.adx.in/p.jpg', takenAt: new Date('2026-10-01T04:00:00Z') }]);
    await addListingPhoto('lst_1', { url: 'https://cdn.adx.in/p.jpg', type: 'left' }, owner);
    expect(repository.uploadedPhotoFacts).toHaveBeenCalledWith(['https://cdn.adx.in/p.jpg']);
    expect(repository.addPhoto).toHaveBeenCalledWith('lst_1', { url: 'https://cdn.adx.in/p.jpg', type: 'left', uploadedFileId: 'upl_7', takenAt: new Date('2026-10-01T04:00:00Z') });

    vi.clearAllMocks();
    repository.addPhoto.mockResolvedValue({ id: 'ph_2' });
    const takenAt = new Date('2026-09-30T10:00:00Z');
    await addListingPhoto('lst_1', { url: 'https://cdn.adx.in/q.jpg', type: 'wide', uploadedFileId: 'upl_8', takenAt }, owner);
    // The client said both, so the register is not asked.
    expect(repository.uploadedPhotoFacts).not.toHaveBeenCalled();
    expect(repository.addPhoto).toHaveBeenCalledWith('lst_1', { url: 'https://cdn.adx.in/q.jpg', type: 'wide', uploadedFileId: 'upl_8', takenAt });
  });

  it('removes only a photograph of this listing', async () => {
    repository.findPhoto.mockResolvedValue({ id: 'ph_9', listingId: 'lst_2', url: 'https://cdn.adx.in/x.jpg', type: 'main', createdAt: new Date() });
    await expect(removeListingPhoto('lst_1', 'ph_9', owner)).rejects.toMatchObject({ statusCode: 404 });
    expect(repository.deletePhoto).not.toHaveBeenCalled();

    repository.findPhoto.mockResolvedValue({ id: 'ph_1', listingId: 'lst_1', url: 'https://cdn.adx.in/p.jpg', type: 'main', createdAt: new Date() });
    await removeListingPhoto('lst_1', 'ph_1', owner);
    expect(repository.deletePhoto).toHaveBeenCalledWith('ph_1');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_pub', 'LISTING_PHOTO_REMOVED', expect.objectContaining({ targetId: 'lst_1' }));
  });
});

describe('the word back on a send-back', () => {
  it('is audited on the listing and every admin is told, the message cut to fit', async () => {
    const long = 'The NOC is on its way from the society office. '.repeat(10);
    const result = await sendListingClarification('lst_1', long, owner);
    expect(result).toMatchObject({ listingId: 'lst_1' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_pub', 'LISTING_CLARIFICATION_SENT', expect.objectContaining({ targetId: 'lst_1', metadata: { message: long } }));
    expect(notifications.createNotification).toHaveBeenCalledTimes(2);
    const [[first]] = notifications.createNotification.mock.calls as [[{ userId: string; message: string; subtitle: string; relatedId: string }]];
    expect(first).toMatchObject({ userId: 'usr_admin1', subtitle: 'MG Road display', relatedId: 'lst_1' });
    expect(first.message.length).toBeLessThanOrEqual(200);
    expect(first.message.endsWith('…')).toBe(true);
  });

  it('is fenced by ownership', async () => {
    await expect(sendListingClarification('lst_1', 'hello there', stranger)).rejects.toMatchObject({ statusCode: 403 });
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});
