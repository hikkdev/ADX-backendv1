import { createNotification } from '../notifications';
import { listAdminUserIds } from '../users';
import { getAgentWithUser } from '../agents';

/** Orders are referred to by their last six characters, upper-cased. */
export function shortId(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}

export function notifyUser(
  userId: string,
  title: string,
  message: string,
  relatedId: string,
): Promise<unknown> {
  return createNotification({ userId, type: 'ORDER', title, message, relatedId });
}

/** Fans an alert out to every admin. */
export async function notifyAdmins(
  title: string,
  message: string,
  relatedId: string,
): Promise<unknown> {
  const adminIds = await listAdminUserIds();
  return Promise.all(adminIds.map((userId) => notifyUser(userId, title, message, relatedId)));
}

/** No-op when the agent or their user is missing, as before. */
export async function notifyAgent(
  agentProfileId: string | null,
  title: string,
  message: string,
  relatedId: string,
): Promise<void> {
  if (!agentProfileId) return;
  const agent = await getAgentWithUser(agentProfileId);
  if (!agent) return;
  await notifyUser(agent.userId, title, message, relatedId);
}
