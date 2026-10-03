import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ST-2 (28 Sep 2026) — supply's half of a listing's private papers.
 *
 * Pinned: filing a document hands its URL to `uploads` to adopt — with who
 * is filing and the host — and stores the URL that comes back (the file's
 * `/files/:id` once it has been moved, the URL as given otherwise); and the
 * read the private-file door asks — which listings name a file — looks for
 * `/files/<id>` and, for a URL recorded while the file was public, the
 * object's own name, never a name too short to be unique.
 */

const { repository, uploads } = vi.hoisted(() => ({
  repository: { findListing: vi.fn(), addDocument: vi.fn(), listingsNamingFile: vi.fn() },
  uploads: { adoptListingDocument: vi.fn() },
}));

vi.mock('../prisma-supply.repository', () => ({ prismaSupplyRepository: repository }));
vi.mock('../../uploads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../uploads')>()),
  adoptListingDocument: uploads.adoptListingDocument,
}));

import { listingsNamingFile, submitDocument } from '../supply.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findListing.mockResolvedValue({ id: 'lst_1', publisherId: 'pub_1' });
  repository.addDocument.mockImplementation(async (data: object) => ({ id: 'doc_1', ...data }));
  repository.listingsNamingFile.mockResolvedValue([]);
});

describe('ST-2: filing a paper', () => {
  it("stores the URL uploads answers after adopting the file", async () => {
    uploads.adoptListingDocument.mockResolvedValue({ url: 'http://api.test/api/v1/files/f1', adopted: true, fileId: 'f1' });
    const filer = { userId: 'usr_pub', isAdmin: false };
    await submitDocument({ listingId: 'lst_1', kind: 'OWNER_NOC', url: 'http://api.test/uploads/1790-noc.jpg', filer, baseUrl: 'http://api.test' });
    expect(uploads.adoptListingDocument).toHaveBeenCalledWith('http://api.test/uploads/1790-noc.jpg', { filer, baseUrl: 'http://api.test' });
    expect(repository.addDocument).toHaveBeenCalledWith({ listingId: 'lst_1', kind: 'OWNER_NOC', url: 'http://api.test/api/v1/files/f1', expiresAt: null });
  });

  it('stores an outside link as given, and adopts nothing for a listing that does not exist', async () => {
    uploads.adoptListingDocument.mockImplementation(async (url: string) => ({ url, adopted: false, fileId: null, reason: 'NOT_IN_REGISTER' }));
    await submitDocument({ listingId: 'lst_1', kind: 'MUNICIPAL_PERMIT', url: 'https://municipal.gov.test/p/1.pdf' });
    expect(uploads.adoptListingDocument).toHaveBeenCalledWith('https://municipal.gov.test/p/1.pdf', { filer: null, baseUrl: '' });
    expect(repository.addDocument).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://municipal.gov.test/p/1.pdf' }));

    uploads.adoptListingDocument.mockClear();
    repository.findListing.mockResolvedValue(null);
    await expect(submitDocument({ listingId: 'lst_x', kind: 'OWNER_NOC', url: 'http://api.test/uploads/1790-noc.jpg' })).rejects.toMatchObject({ statusCode: 404 });
    expect(uploads.adoptListingDocument).not.toHaveBeenCalled();
  });
});

describe('ST-2: which listings name a file', () => {
  it('matches /files/<id>, and the object name when it is long enough to be unique', async () => {
    await listingsNamingFile({ fileId: 'f1', objectName: '1790282546088-wazekd1u7wd.png' });
    expect(repository.listingsNamingFile).toHaveBeenLastCalledWith(['/files/f1', '/1790282546088-wazekd1u7wd.png']);
    await listingsNamingFile({ fileId: 'f1', objectName: 'a.png' });
    expect(repository.listingsNamingFile).toHaveBeenLastCalledWith(['/files/f1']);
    await listingsNamingFile({ fileId: 'f1', objectName: null });
    expect(repository.listingsNamingFile).toHaveBeenLastCalledWith(['/files/f1']);
  });
});
