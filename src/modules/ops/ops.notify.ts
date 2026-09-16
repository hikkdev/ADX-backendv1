import { createNotification } from '../notifications';
import { listAdminUserIds } from '../users';
import { OPS_NOTIFICATION_TYPE } from './ops.keys';

/**
 * Tells every ADMIN account — the on-call list until there is a rota
 * (decision 95). Composed here from `users` and `notifications` rather than
 * borrowed from `orders`, so this module never depends on the order domain.
 * Returns how many people were told: zero means nobody could be.
 */
export async function notifyAdmins(input: {
  title: string;
  message: string;
  subtitle?: string;
  suggestedAction?: string;
  relatedId?: string;
}): Promise<number> {
  const adminIds = await listAdminUserIds();
  await Promise.all(
    adminIds.map((userId) =>
      createNotification({
        userId,
        type: OPS_NOTIFICATION_TYPE,
        title: input.title,
        message: input.message,
        ...(input.subtitle ? { subtitle: input.subtitle } : {}),
        ...(input.suggestedAction ? { suggestedAction: input.suggestedAction } : {}),
        ...(input.relatedId ? { relatedId: input.relatedId } : {}),
      }),
    ),
  );
  return adminIds.length;
}
