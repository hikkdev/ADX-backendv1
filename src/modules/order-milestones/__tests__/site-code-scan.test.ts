import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 3 Oct 2026 — a milestone's `qr_scan` is the sticker read at the spot.
 *
 * Until now any text passed, and the agent app filled it with the listing's
 * token straight off the order read — so the sign-off proved nothing. The
 * token no longer leaves the server; completion checks the scanned code the
 * way the order check-in does: the listing's own token, or a signed SITE /
 * ORDER code for this listing or order.
 */

const { repository, qr, orders, logger } = vi.hoisted(() => ({
  repository: {
    findWithOrderStatus: vi.fn(),
    findSiteCode: vi.fn(),
    complete: vi.fn(),
  },
  qr: { isSignedCodeFor: vi.fn() },
  orders: {
    getAgentOrderIdsAwaitingWork: vi.fn(),
    updateAgentLocation: vi.fn(),
    OFFER_EXPIRED_REASON: 'EXPIRED',
    rejectionText: (reason: string) => reason,
    shortId: (id: string) => id.slice(-6).toUpperCase(),
    notifyAdmins: vi.fn(),
    notifyAgent: vi.fn(),
    slotCandidates: vi.fn(),
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../prisma-order-milestones.repository', () => ({ prismaOrderMilestonesRepository: repository }));
vi.mock('../../qr', () => qr);
vi.mock('../../orders', () => orders);
vi.mock('../../../shared/logging', () => ({ logger }));

import { completeMilestone } from '../agent/agent-execution.service';

const AGENT = 'agt_1';
const milestone = {
  id: 'ms_1',
  orderId: 'ord_1',
  assignedAgentId: AGENT,
  status: 'IN_PROGRESS',
  template: { title: 'Installation', requirements: [{ kind: 'qr_scan' }] },
  orderRecord: { status: 'IN_PROGRESS', agentId: AGENT, startDate: null, endDate: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithOrderStatus.mockResolvedValue(milestone);
  repository.findSiteCode.mockResolvedValue({ listingId: 'lst_1', qrToken: 'site-token-1' });
  repository.complete.mockResolvedValue({ id: 'ms_1', status: 'COMPLETED' });
  qr.isSignedCodeFor.mockResolvedValue(false);
});

describe('signing off a step that asks for the site code', () => {
  it('passes with the sticker the listing carries', async () => {
    await completeMilestone('ms_1', AGENT, [{ kind: 'qr_scan', value: ' site-token-1 ' }]);
    expect(repository.complete).toHaveBeenCalledOnce();
  });

  it('passes with a signed site or order code for this spot', async () => {
    qr.isSignedCodeFor.mockResolvedValue(true);
    await completeMilestone('ms_1', AGENT, [{ kind: 'qr_scan', value: 'signed.code' }]);
    expect(qr.isSignedCodeFor).toHaveBeenCalledWith('signed.code', { listingId: 'lst_1', orderId: 'ord_1' });
    expect(repository.complete).toHaveBeenCalledOnce();
  });

  it('refuses any other text, and writes nothing', async () => {
    await expect(completeMilestone('ms_1', AGENT, [{ kind: 'qr_scan', value: 'anything' }])).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_QR',
    });
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it('reads nothing extra when the step asks for no code', async () => {
    repository.findWithOrderStatus.mockResolvedValue({ ...milestone, template: { title: 'Visit', requirements: [] } });
    await completeMilestone('ms_1', AGENT, []);
    expect(repository.findSiteCode).not.toHaveBeenCalled();
    expect(repository.complete).toHaveBeenCalledOnce();
  });
});
