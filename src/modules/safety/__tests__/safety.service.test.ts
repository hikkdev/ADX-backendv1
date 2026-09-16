import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 07, wave 4 — the report that blocks a job.
 *
 * What is pinned: an unsafe-site report takes the agent off the order before
 * anybody is told, so no ops notification points at a job the agent is still
 * holding; a location share blocks nothing; every admin hears about it with
 * the SFT- number; and the raiser hears back when ops pick it up or close it.
 */

const { repository, identifiers, users, notifications, audit } = vi.hoisted(() => ({
  repository: {
    create: vi.fn(),
    findById: vi.fn(),
    findManyForUser: vi.fn(),
    findQueue: vi.fn(),
    update: vi.fn(),
    findOrderForActor: vi.fn(),
    releaseOrderFromAgent: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  users: { getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() },
  notifications: { createNotification: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-safety.repository', () => ({ prismaSafetyRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);
vi.mock('../../../shared/audit', () => audit);

import { raiseAlert, updateAlert } from '../safety.service';
import { BLOCKING_KINDS } from '../safety.types';

const agent = { sub: 'usr_agt', roles: ['AGENT_PUBLISHER'] };
const admin = { sub: 'usr_admin', roles: ['ADMIN'] };
const order = { id: 'ord_00000341', status: 'IN_PROGRESS', agentId: 'agt_1' };

beforeEach(() => {
  vi.clearAllMocks();
  identifiers.allocateIdentifier.mockResolvedValue('SFT-1109-2601');
  users.listAdminUserIds.mockResolvedValue(['usr_admin', 'usr_admin2']);
  users.getUserDisplayName.mockResolvedValue('Rahul Kumar');
  repository.findOrderForActor.mockResolvedValue(order);
  repository.create.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'sft_1', status: 'OPEN', ...data }));
  repository.findById.mockResolvedValue({ id: 'sft_1', displayId: 'SFT-1109-2601', raisedByUserId: 'usr_agt', status: 'OPEN', acknowledgedAt: null });
  // T-B: the update answers the queue's row — the alert with its raiser and order.
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
    id,
    ...patch,
    raisedBy: { id: 'usr_agt', name: 'Rahul Kumar', mobile: '+919000000001' },
    order: { id: order.id, status: order.status, listing: { title: 'Warehouse Gate 2', address: 'Koramangala', city: 'Bengaluru' } },
  }));
});

describe('reporting an unsafe site', () => {
  it('mints SFT-, takes the job off the agent before anybody is told, and tells every admin', async () => {
    const alert = await raiseAlert(agent, { kind: 'UNSAFE_SITE', orderId: order.id, note: 'Live wires across the wall.' });
    expect(identifiers.allocateIdentifier).toHaveBeenCalledWith('SAFETY');
    expect(alert).toMatchObject({ displayId: 'SFT-1109-2601', blockedOrder: true, orderId: order.id });
    expect(repository.releaseOrderFromAgent).toHaveBeenCalledWith(order.id);
    expect(repository.releaseOrderFromAgent.mock.invocationCallOrder[0]).toBeLessThan(notifications.createNotification.mock.invocationCallOrder[0]!);
    const told = notifications.createNotification.mock.calls.map((call) => call[0]);
    expect(told.map((n) => n.userId).sort()).toEqual(['usr_admin', 'usr_admin2']);
    expect(told[0]).toMatchObject({ title: 'Safety: unsafe site reported', subtitle: 'SFT-1109-2601' });
    expect(told[0]!.message).toContain('the job has been taken off them');
    expect(audit.logActivity).toHaveBeenCalledWith('usr_agt', 'SAFETY_ALERT_RAISED', undefined, expect.objectContaining({ blockedOrder: true }));
  });

  it('a location share blocks nothing, and an alert without an order blocks nothing', async () => {
    await raiseAlert(agent, { kind: 'LOCATION_SHARE', orderId: order.id, latitude: 12.97, longitude: 77.59 });
    expect(repository.releaseOrderFromAgent).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ blockedOrder: false, latitude: 12.97 }));

    repository.findOrderForActor.mockClear();
    await raiseAlert(agent, { kind: 'UNSAFE_SITE', note: 'Nowhere in particular.' });
    expect(repository.findOrderForActor).not.toHaveBeenCalled();
    expect(repository.releaseOrderFromAgent).not.toHaveBeenCalled();
  });

  it('refuses an order that does not exist', async () => {
    repository.findOrderForActor.mockResolvedValueOnce(null);
    await expect(raiseAlert(agent, { kind: 'UNSAFE_SITE', orderId: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('names the three kinds that block a job', () => {
    expect(BLOCKING_KINDS).toEqual(['UNSAFE_SITE', 'HARASSMENT', 'ACCIDENT']);
  });
});

describe('ops on an alert', () => {
  it('acknowledging stamps who and when, and the raiser hears back', async () => {
    const updated = await updateAlert('sft_1', admin, { status: 'ACKNOWLEDGED', opsNote: 'Calling you now.' });
    expect(updated).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedById: 'usr_admin' });
    // T-B: the answer is the queue's row — who raised it and the order it is on
    expect(updated).toMatchObject({ raisedBy: { id: 'usr_agt', name: 'Rahul Kumar', mobile: '+919000000001' }, order: expect.objectContaining({ id: order.id, listing: expect.objectContaining({ title: 'Warehouse Gate 2' }) }) });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_agt', title: 'ADX is on your safety report', message: 'Calling you now.' }));
  });

  it('closing stamps the close and says so', async () => {
    const updated = await updateAlert('sft_1', admin, { status: 'CLOSED' });
    expect(updated).toMatchObject({ status: 'CLOSED', closedById: 'usr_admin' });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Safety report closed' }));
  });

  it('a missing alert is 404', async () => {
    repository.findById.mockResolvedValueOnce(null);
    await expect(updateAlert('sft_9', admin, { status: 'CLOSED' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
