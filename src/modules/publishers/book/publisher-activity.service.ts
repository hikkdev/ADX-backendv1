import type { AccountActivity } from '../../../shared/database';
import { ApiError } from '../../../shared/errors';
import { toListPage, type ListPage } from '../../../shared/pagination';
import { findAgentProfile } from '../../agents';
import { prismaPublishersRepository as publishers } from '../prisma-publishers.repository';
import { assertAgentOwnsPublisher } from '../publishers.policy';
import { prismaPublisherSummaryRepository as repository } from './prisma-publisher-summary.repository';
import type { PublisherActivityInput, PublisherActivityQuery } from './publisher-book.schema';

/**
 * R-B: the publisher's action log (decision 14) — Check in, Follow up, a
 * call, a message, a note — the mirror of `POST /advertisers/:id/activity`.
 * Lot P's detail card read these rows by `publisherId` and nothing wrote
 * them; this is the writer, and the console card's read of the log.
 *
 * A READ-level act, the advertiser's rule: the agent the account is
 * attributed to may log without a live grant — a phone call is not a write
 * to the account — and so may ADMIN, recorded against the account's own
 * agent (an admin who also carries an agent profile logs as themselves).
 * Another agent, or a caller with no agent profile, is 403; a publisher with
 * no agent to log against is 409 on the admin's write.
 */

export type ActivityViewer = { userId: string; isAdmin: boolean };

export type PublisherActivityView = { id: string; kind: string; note: string | null; at: string; agentId: string };

const toView = (row: AccountActivity): PublisherActivityView => ({ id: row.id, kind: row.kind, note: row.note ?? null, at: row.at.toISOString(), agentId: row.agentId });

/** The row, and who acts on it: the agent's own id on attribution, or the account's agent (nullable) for ADMIN. */
async function actingOn(publisherId: string, viewer: ActivityViewer): Promise<{ agentId: string | null }> {
  const publisher = await publishers.findSummaryById(publisherId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'Publisher not found');
  if (viewer.isAdmin) return { agentId: (await findAgentProfile(viewer.userId))?.id ?? publisher.agentId };
  return { agentId: await assertAgentOwnsPublisher(viewer.userId, publisher.agentId) };
}

export async function recordPublisherActivity(
  publisherId: string,
  viewer: ActivityViewer,
  input: PublisherActivityInput,
  now = new Date(),
): Promise<PublisherActivityView> {
  const { agentId } = await actingOn(publisherId, viewer);
  if (!agentId) throw new ApiError(409, 'CONFLICT', 'This account has no agent to log against');
  const row = await repository.createActivity({ publisherId, agentId, kind: input.kind, note: input.note ?? null, createdByUserId: viewer.userId, at: now });
  return toView(row);
}

export async function listPublisherActivity(publisherId: string, viewer: ActivityViewer, query: PublisherActivityQuery): Promise<ListPage<PublisherActivityView>> {
  await actingOn(publisherId, viewer);
  const { items, total, counts } = await repository.listActivity(publisherId, query);
  return toListPage(items.map(toView), total, counts, query);
}
