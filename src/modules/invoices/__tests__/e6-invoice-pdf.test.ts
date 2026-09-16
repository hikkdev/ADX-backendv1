import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E6: the invoice PDF on the party route. Lot D stored it PRIVATE under the
 * issuer and answered a 302 to `/files/:id`, whose door refused the
 * advertiser. Now the file is owned by the advertiser's user, and the route
 * streams the stored bytes itself — no redirect for the caller to follow.
 */

const { repository, advertisers, uploads, service, pdf } = vi.hoisted(() => ({
  repository: { findInvoice: vi.fn(), updateInvoice: vi.fn() },
  advertisers: { assertMayActFor: vi.fn(), getAdvertiser: vi.fn() },
  uploads: { openStoredFile: vi.fn(), storeGeneratedFile: vi.fn() },
  service: {
    getInvoiceForAdvertiser: vi.fn(),
    getInvoice: vi.fn(),
    getLegalEntity: vi.fn(async () => ({ pan: null, cin: null, legalName: 'ADX', registeredAddress: null, city: null, stateName: null })),
  },
  pdf: { renderInvoicePdf: vi.fn(async () => Buffer.from('%PDF-1.4 fresh')) },
}));

vi.mock('../prisma-invoices.repository', () => ({ prismaInvoicesRepository: repository }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../uploads', () => uploads);
vi.mock('../pdf', () => pdf);
vi.mock('../invoices.service', () => service);
vi.mock('../statements.service', () => ({
  listStatementsForUser: vi.fn(),
  monthWindowFor: vi.fn(),
  previousMonth: vi.fn(),
  runMonthlyStatements: vi.fn(),
  statementPdf: vi.fn(),
}));

import { advertiserInvoicePdfHandler } from '../invoices.controller';

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 'inv_1',
  number: 'INV/2026-27/000018',
  advertiserId: 'adv_1',
  createdById: 'usr_admin',
  voidsInvoiceId: null,
  pdfFileId: null,
  lines: [],
  ...over,
});

const response = () => {
  const headers: Record<string, string> = {};
  const res: Record<string, unknown> = { headersSent: false };
  res['set'] = vi.fn((key: string, value: string) => {
    headers[key] = value;
    return res;
  });
  res['redirect'] = vi.fn();
  res['send'] = vi.fn(() => res);
  res['sendFile'] = vi.fn((_path: string, cb?: (err?: unknown) => void) => {
    res['headersSent'] = true;
    cb?.();
  });
  return { res: res as never, headers, fns: res as Record<string, ReturnType<typeof vi.fn>> };
};

const req = { params: { id: 'adv_1', invoiceId: 'inv_1' }, user: { sub: 'usr_adv', roles: ['ADVERTISER'] }, get: () => 'localhost', protocol: 'http' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  advertisers.getAdvertiser.mockResolvedValue({ id: 'adv_1', userId: 'usr_adv' });
  uploads.storeGeneratedFile.mockResolvedValue({ id: 'file_1' });
});

describe('GET /advertisers/:id/invoices/:invoiceId/pdf', () => {
  it('streams a stored local file rather than redirecting to /files/:id', async () => {
    service.getInvoiceForAdvertiser.mockResolvedValue(invoice({ pdfFileId: 'file_1' }));
    uploads.openStoredFile.mockResolvedValue({ kind: 'stream', path: '/srv/private/inv.pdf', mimeType: 'application/pdf', filename: 'inv.pdf' });
    const { res, fns, headers } = response();
    await advertiserInvoicePdfHandler(req, res);
    expect(advertisers.assertMayActFor).toHaveBeenCalledWith(req, 'adv_1', 'READ');
    expect(fns['sendFile']).toHaveBeenCalledWith('/srv/private/inv.pdf', expect.any(Function));
    expect(fns['redirect']).not.toHaveBeenCalled();
    expect(headers['Content-Disposition']).toBe('inline; filename="INV-2026-27-000018.pdf"');
    expect(pdf.renderInvoicePdf).not.toHaveBeenCalled();
  });

  it('renders on first read and stores the file owned by the advertiser\'s user', async () => {
    service.getInvoiceForAdvertiser.mockResolvedValue(invoice());
    const { res, fns } = response();
    await advertiserInvoicePdfHandler(req, res);
    expect(uploads.storeGeneratedFile).toHaveBeenCalledWith(
      'usr_admin',
      expect.objectContaining({ purpose: 'INVOICE', ownerUserId: 'usr_adv', filename: 'INV-2026-27-000018.pdf' }),
    );
    expect(repository.updateInvoice).toHaveBeenCalledWith('inv_1', { pdfFileId: 'file_1' });
    expect(fns['send']).toHaveBeenCalledWith(Buffer.from('%PDF-1.4 fresh'));
    expect(fns['redirect']).not.toHaveBeenCalled();
  });

  it('re-renders when the stored object cannot be opened', async () => {
    service.getInvoiceForAdvertiser.mockResolvedValue(invoice({ pdfFileId: 'file_gone' }));
    uploads.openStoredFile.mockResolvedValue(null);
    const { res, fns } = response();
    await advertiserInvoicePdfHandler(req, res);
    expect(pdf.renderInvoicePdf).toHaveBeenCalled();
    expect(fns['send']).toHaveBeenCalled();
  });
});
