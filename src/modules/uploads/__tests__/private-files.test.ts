import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q61) — private files.
 *
 * What is pinned: a KYC upload is stored out of public reach and recorded
 * with a `/files/:id` URL; a listing photo keeps its public URL; opening a
 * private file is the owner's, an admin's, or the party's agent's under a
 * live grant — anyone else is 403; opening an identity document leaves a
 * FILE_VIEWED row and opening a top-up proof does not; a public file still
 * answers with a redirect to where it always lived; deletion is the owner's
 * or an admin's, removes the object and the row, and is audited.
 */

const { repository, storage, audit, fs } = vi.hoisted(() => ({
  repository: { record: vi.fn(), findById: vi.fn(), remove: vi.fn() },
  storage: { uploadFile: vi.fn(), openPrivateFile: vi.fn(), deleteStoredFile: vi.fn() },
  audit: { logActivity: vi.fn() },
  fs: { promises: { unlink: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) } },
}));

vi.mock('../prisma-uploads.repository', () => ({ prismaUploadsRepository: repository }));
vi.mock('../../../shared/storage', () => storage);
vi.mock('../../../shared/audit', () => audit);
vi.mock('fs', () => ({ default: fs, ...fs }));

import { deleteFile, openFile, storeGeneratedFile, storeUpload } from '../uploads.service';
import { registerFileAccessPort } from '../file-access.port';
import { PRIVATE_PURPOSES, isPrivatePurpose } from '../uploads.schema';

const incoming = { path: '/tmp/x', filename: 'x.png', originalname: 'aadhaar.png', mimetype: 'image/png', size: 1234 };

beforeEach(() => {
  vi.clearAllMocks();
  repository.record.mockImplementation(async (data: Record<string, unknown>) => ({ ...data }));
  storage.uploadFile.mockImplementation(async (opts: { visibility?: string; folder: string; filename: string; baseUrl: string }) =>
    opts.visibility === 'PRIVATE'
      ? { url: null, provider: 'local', storageKey: `local:private/${opts.folder}/${opts.filename}` }
      : { url: `${opts.baseUrl}/uploads/${opts.filename}`, provider: 'local', storageKey: `local:${opts.folder}/${opts.filename}` },
  );
  registerFileAccessPort({ agentMayView: async () => false });
});

describe('which purposes are private', () => {
  it('is the identity documents, the money proofs, the dispute evidence and the invoice', () => {
    expect([...PRIVATE_PURPOSES].sort()).toEqual(
      ['ADVERTISER_KYC', 'AGENT_KYC', 'BOOKING_REPORT', 'CALL_RECORDING', 'DATA_EXPORT', 'DISPUTE_EVIDENCE', 'EMPLOYEE_KYC', 'INVOICE', 'KYC', 'LEAD_CAPTURE', 'PARTNER_INVOICE', 'PARTNER_RATE_CARD', 'PRINT_PARTNER_KYC', 'REPORT', 'SIGNED_AGREEMENT', 'SUPPORT_ATTACHMENT', 'TOPUP_PROOF', 'USER_KYC', 'VISIT_PROOF'].sort(),
    );
    expect(isPrivatePurpose('LISTING_PHOTO')).toBe(false);
    expect(isPrivatePurpose('AVATAR')).toBe(false);
  });
});

describe('storing', () => {
  it('stores a KYC upload privately and records a /files/:id URL that names the row', async () => {
    registerFileAccessPort({ agentMayView: async (viewer, owner) => viewer === 'usr_agent' && owner === 'usr_pub' });
    const record = await storeUpload('usr_agent', incoming, 'KYC', 'http://localhost:4000', { ownerUserId: 'usr_pub' });
    expect(storage.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'PRIVATE', folder: 'kyc' }));
    expect(record).toMatchObject({
      visibility: 'PRIVATE',
      ownerUserId: 'usr_pub',
      storageKey: 'local:private/kyc/x.png',
      purpose: 'KYC',
    });
    expect(record.url).toBe(`http://localhost:4000/api/v1/files/${record.id}`);
    expect(record.id).toMatch(/^[a-f0-9]{32}$/);
  });

  /* Lot F: naming an owner is an on-behalf write — the party's agent under a
     live grant, or ADMIN. A stranger naming an owner is refused before
     anything is stored, and the temp file still goes. */
  it('lets an agent file a party document only under a live grant; ADMIN always; a stranger is 403', async () => {
    registerFileAccessPort({ agentMayView: async (viewer, owner) => viewer === 'usr_agent' && owner === 'usr_pub' });

    await expect(storeUpload('usr_agent', incoming, 'KYC', 'http://localhost:4000', { ownerUserId: 'usr_pub' })).resolves.toMatchObject({ ownerUserId: 'usr_pub' });
    await expect(storeUpload('usr_admin', incoming, 'KYC', 'http://localhost:4000', { ownerUserId: 'usr_pub', isAdmin: true })).resolves.toMatchObject({ ownerUserId: 'usr_pub' });
    // Their own document, named as their own: nothing to ask.
    await expect(storeUpload('usr_pub', incoming, 'KYC', 'http://localhost:4000', { ownerUserId: 'usr_pub' })).resolves.toMatchObject({ ownerUserId: 'usr_pub' });

    storage.uploadFile.mockClear();
    repository.record.mockClear();
    await expect(storeUpload('usr_agent', incoming, 'KYC', 'http://localhost:4000', { ownerUserId: 'usr_other_pub' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(storeUpload('usr_stranger', incoming, 'KYC', 'http://localhost:4000', { ownerUserId: 'usr_pub' })).rejects.toMatchObject({ statusCode: 403 });
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(repository.record).not.toHaveBeenCalled();

    // The grant has ended: the same agent, refused.
    registerFileAccessPort({ agentMayView: async () => false });
    await expect(storeUpload('usr_agent', incoming, 'KYC', 'http://localhost:4000', { ownerUserId: 'usr_pub' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('keeps a listing photo public, with the URL the provider gave', async () => {
    const record = await storeUpload('usr_pub', incoming, 'LISTING_PHOTO', 'http://localhost:4000');
    expect(storage.uploadFile).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'PUBLIC' }));
    expect(record).toMatchObject({ visibility: 'PUBLIC', url: 'http://localhost:4000/uploads/x.png', ownerUserId: null });
  });

  it('removes the temp file either way', async () => {
    storage.uploadFile.mockRejectedValueOnce(new Error('bucket down'));
    await expect(storeUpload('usr_pub', incoming, 'KYC', '')).rejects.toThrow('bucket down');
    expect(fs.promises.unlink).toHaveBeenCalledWith('/tmp/x');
  });

  it('files a generated invoice privately, owned by the party it was issued to', async () => {
    const record = await storeGeneratedFile('usr_admin', {
      content: Buffer.from('%PDF'),
      filename: 'INV-1.pdf',
      mimeType: 'application/pdf',
      purpose: 'INVOICE',
      ownerUserId: 'usr_adv',
    });
    expect(record).toMatchObject({ visibility: 'PRIVATE', ownerUserId: 'usr_adv', sizeBytes: 4 });
    expect(record.url).toBe(`/api/v1/files/${record.id}`);
  });
});

describe('opening', () => {
  const privateFile = {
    id: 'f1',
    userId: 'usr_agent',
    ownerUserId: 'usr_pub',
    url: '/api/v1/files/f1',
    filename: 'aadhaar.png',
    mimeType: 'image/png',
    purpose: 'KYC',
    visibility: 'PRIVATE',
    storageKey: 'local:private/kyc/x.png',
  };

  beforeEach(() => {
    repository.findById.mockResolvedValue(privateFile);
    storage.openPrivateFile.mockResolvedValue({ kind: 'stream', path: '/srv/private-uploads/private/kyc/x.png' });
  });

  it('lets the owner open it and records that they looked', async () => {
    const opened = await openFile('f1', { userId: 'usr_pub', isAdmin: false });
    expect(opened).toEqual({ kind: 'stream', path: '/srv/private-uploads/private/kyc/x.png', mimeType: 'image/png', filename: 'aadhaar.png' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_pub', 'FILE_VIEWED', expect.objectContaining({ targetType: 'UploadedFile', targetId: 'f1' }));
  });

  it('lets an admin open it, and the party agent only under a live grant', async () => {
    await expect(openFile('f1', { userId: 'usr_admin', isAdmin: true })).resolves.toMatchObject({ kind: 'stream' });
    await expect(openFile('f1', { userId: 'usr_stranger', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });

    registerFileAccessPort({ agentMayView: async (viewer, owner) => viewer === 'usr_agent2' && owner === 'usr_pub' });
    await expect(openFile('f1', { userId: 'usr_agent2', isAdmin: false })).resolves.toMatchObject({ kind: 'stream' });
    await expect(openFile('f1', { userId: 'usr_agent3', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
  });

  /* Lot F: evidence filed against somebody is theirs to see. The door asks
     the port who the case is between; only DISPUTE_EVIDENCE asks. */
  it('opens a DISPUTE_EVIDENCE file to the other side of the case, and to nobody else', async () => {
    const asked: string[] = [];
    registerFileAccessPort({
      agentMayView: async () => false,
      disputePartyMayView: async (viewer, fileId, holders) => {
        asked.push(`${viewer}:${fileId}:${holders.join('+')}`);
        return viewer === 'usr_counterparty';
      },
    });
    repository.findById.mockResolvedValue({ ...privateFile, purpose: 'DISPUTE_EVIDENCE', userId: 'usr_adv', ownerUserId: null });

    await expect(openFile('f1', { userId: 'usr_counterparty', isAdmin: false })).resolves.toMatchObject({ kind: 'stream' });
    await expect(openFile('f1', { userId: 'usr_stranger', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
    // The port is told whose file it is, so only a case of theirs can open it.
    expect(asked).toEqual(['usr_counterparty:f1:usr_adv', 'usr_stranger:f1:usr_adv']);
    // Evidence is not an identity document: no FILE_VIEWED row.
    expect(audit.logActivity).not.toHaveBeenCalled();

    // Uploaded by an agent on the party's behalf: both are the file's holders, once each.
    asked.length = 0;
    repository.findById.mockResolvedValue({ ...privateFile, purpose: 'DISPUTE_EVIDENCE', userId: 'usr_agent', ownerUserId: 'usr_pub' });
    await expect(openFile('f1', { userId: 'usr_counterparty', isAdmin: false })).resolves.toMatchObject({ kind: 'stream' });
    expect(asked).toEqual(['usr_counterparty:f1:usr_pub+usr_agent']);

    // A KYC file never asks the dispute question.
    asked.length = 0;
    repository.findById.mockResolvedValue(privateFile);
    await expect(openFile('f1', { userId: 'usr_counterparty', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
    expect(asked).toEqual([]);
  });

  /* Lot I: a support attachment is the thread's. The desk is admitted before
     the port is asked; the requester is admitted by it; a stranger never. */
  it('opens a SUPPORT_ATTACHMENT to the ticket requester through the port, and to nobody else', async () => {
    const asked: string[] = [];
    registerFileAccessPort({
      agentMayView: async () => false,
      supportPartyMayView: async (viewer, fileId) => {
        asked.push(`${viewer}:${fileId}`);
        return viewer === 'usr_requester';
      },
    });
    repository.findById.mockResolvedValue({ ...privateFile, purpose: 'SUPPORT_ATTACHMENT', userId: 'usr_admin', ownerUserId: null });

    await expect(openFile('f1', { userId: 'usr_requester', isAdmin: false })).resolves.toMatchObject({ kind: 'stream' });
    await expect(openFile('f1', { userId: 'usr_stranger', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
    await expect(openFile('f1', { userId: 'usr_other_admin', isAdmin: true })).resolves.toMatchObject({ kind: 'stream' });
    expect(asked).toEqual(['usr_requester:f1', 'usr_stranger:f1']);
    expect(audit.logActivity).not.toHaveBeenCalled();

    // Unregistered, the requester is refused: the file is the uploader's and the desk's.
    registerFileAccessPort({ agentMayView: async () => false });
    await expect(openFile('f1', { userId: 'usr_requester', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('keeps evidence closed when no port answers the dispute question', async () => {
    registerFileAccessPort({ agentMayView: async () => false });
    repository.findById.mockResolvedValue({ ...privateFile, purpose: 'DISPUTE_EVIDENCE', userId: 'usr_adv', ownerUserId: null });
    await expect(openFile('f1', { userId: 'usr_counterparty', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('hands back the presigned URL when the object lives on R2', async () => {
    storage.openPrivateFile.mockResolvedValue({ kind: 'redirect', url: 'https://acct.r2.cloudflarestorage.com/b/private/kyc/x.png?X-Amz-Signature=abc' });
    const opened = await openFile('f1', { userId: 'usr_pub', isAdmin: false });
    expect(opened).toEqual({ kind: 'redirect', url: expect.stringContaining('X-Amz-Signature') });
    expect(storage.openPrivateFile).toHaveBeenCalledWith('local:private/kyc/x.png', { filename: 'aadhaar.png', mimeType: 'image/png' });
  });

  it('does not log a view of a top-up proof; only identity documents are on the trail', async () => {
    repository.findById.mockResolvedValue({ ...privateFile, purpose: 'TOPUP_PROOF' });
    await openFile('f1', { userId: 'usr_pub', isAdmin: false });
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('redirects a public file to where it always lived, for anyone signed in', async () => {
    repository.findById.mockResolvedValue({ ...privateFile, visibility: 'PUBLIC', url: 'http://localhost:4000/uploads/x.png', purpose: 'LISTING_PHOTO' });
    await expect(openFile('f1', { userId: 'usr_stranger', isAdmin: false })).resolves.toEqual({ kind: 'redirect', url: 'http://localhost:4000/uploads/x.png' });
    expect(storage.openPrivateFile).not.toHaveBeenCalled();
  });

  it('is 404 for an id nobody recorded', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(openFile('nope', { userId: 'usr_pub', isAdmin: false })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('deleting', () => {
  const file = { id: 'f1', userId: 'usr_pub', ownerUserId: null, purpose: 'KYC', visibility: 'PRIVATE', storageKey: 'local:private/kyc/x.png' };

  beforeEach(() => {
    repository.findById.mockResolvedValue(file);
  });

  it('is the owner or an admin; the object goes, the row goes, the trail says so', async () => {
    await deleteFile('f1', { userId: 'usr_pub', isAdmin: false });
    expect(storage.deleteStoredFile).toHaveBeenCalledWith('local:private/kyc/x.png');
    expect(repository.remove).toHaveBeenCalledWith('f1');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_pub', 'FILE_DELETED', expect.objectContaining({ targetId: 'f1' }));

    await expect(deleteFile('f1', { userId: 'usr_admin', isAdmin: true })).resolves.toBeUndefined();
    await expect(deleteFile('f1', { userId: 'usr_stranger', isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
  });
});
