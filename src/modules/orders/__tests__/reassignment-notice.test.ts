import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot F (E7-1): the push behind a reassignment opens the order.
 *
 * What is pinned: `notifyAgent` / `notifyUser` write an ORDER row whose
 * `relatedId` IS the order id — for both agents of a reassignment, the one
 * losing the order (ORDER_AGENT_REASSIGNED) and the one gaining it — so the
 * app's tap on the notice lands on the order and nowhere else. A
 * `relatedType` column does not exist yet (see schema_needs); until it does,
 * `type: 'ORDER'` is the type discriminator the apps route on.
 */

const { notifications, users, agents } = vi.hoisted(() => ({
  notifications: { createNotification: vi.fn(async (data: unknown) => ({ id: 'ntf_1', ...(data as object) })) },
  users: { listAdminUserIds: vi.fn(async () => ['usr_admin']) },
  agents: { getAgentWithUser: vi.fn() },
}));

vi.mock('../../notifications', () => notifications);
vi.mock('../../users', () => users);
vi.mock('../../agents', () => agents);

import { notifyAdmins, notifyAgent, notifyUser, shortId } from '../orders.notify';

beforeEach(() => {
  vi.clearAllMocks();
  agents.getAgentWithUser.mockImplementation(async (agentId: string) => (agentId === 'agt_gone' ? null : { id: agentId, userId: `usr_${agentId}` }));
});

describe('the reassignment notices', () => {
  it('carry relatedId = the order id and type ORDER, for the agent who lost it and the one who gained it', async () => {
    await notifyAgent('agt_old', 'Order reassigned', `Order ${shortId('ord_abc123def456')} has been reassigned by ADX. Reason: unreachable`, 'ord_abc123def456');
    await notifyAgent('agt_new', 'New order assigned', `Order ${shortId('ord_abc123def456')} has been assigned to you.`, 'ord_abc123def456');

    expect(notifications.createNotification).toHaveBeenNthCalledWith(1, {
      userId: 'usr_agt_old',
      type: 'ORDER',
      title: 'Order reassigned',
      message: expect.stringContaining('DEF456'),
      relatedId: 'ord_abc123def456',
      relatedType: 'ORDER',
    });
    expect(notifications.createNotification).toHaveBeenNthCalledWith(2, {
      userId: 'usr_agt_new',
      type: 'ORDER',
      title: 'New order assigned',
      message: expect.any(String),
      relatedId: 'ord_abc123def456',
      relatedType: 'ORDER',
    });
  });

  it('is a no-op for an agent with no user behind them, and fans an admin alert out with the same relatedId', async () => {
    await notifyAgent('agt_gone', 'Order reassigned', 'x', 'ord_1');
    expect(notifications.createNotification).not.toHaveBeenCalled();

    await notifyAdmins('Agent unreachable', 'Nobody answered', 'ord_1');
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_admin', type: 'ORDER', relatedId: 'ord_1', relatedType: 'ORDER' }));

    await notifyUser('usr_adv', 'Order cancelled', 'x', 'ord_2');
    expect(notifications.createNotification).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'usr_adv', relatedId: 'ord_2' }));
  });
});
