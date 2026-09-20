import { ApiError } from '../../shared/errors';
import { allocateIdentifier } from '../identifiers';
import { prismaDraftsRepository as repository } from './prisma-drafts.repository';
import type { DeskDraftsQuery, SaveDraftInput } from './drafts.schema';
import type { DeskDraft } from './drafts.repository';

/**
 * QR-8 (the owner, 17 Sep 2026): "allow draft facility for listings and
 * campaigns. We can use it to reach out to advertisers or publishers later
 * with sales team or onboarding team. We might need alphanumerical unique
 * listing IDs too."
 *
 * A campaign has been a draft from its first step since DR 03 (the
 * `Campaign` row is created DRAFT and carries `ADX-CMP-…`); this is the
 * listing's half. The wizard's answers are saved whole, with the step the
 * person stopped on, under a reference minted from the LISTING series
 * (`LST-DDMM-YYNN`) — the same reference the listing takes when the draft
 * is finished (`createListing` with `draftId`), so the desk and the
 * publisher call the spot by one name throughout. The desk reads every
 * publisher's drafts, oldest-untouched first, with the publisher's name and
 * number beside each: the call list.
 */

export async function listMyDrafts(publisherId: string) {
  return repository.listForPublisher(publisherId);
}

export async function saveDraft(publisherId: string, id: string | null, input: SaveDraftInput) {
  if (!id) return repository.create(publisherId, await allocateIdentifier('LISTING'), input);
  const existing = await repository.findForPublisher(publisherId, id);
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'That draft is not yours, or is gone');
  return repository.update(id, input);
}

/** The draft a listing is being finished from — the caller's own, or 404. */
export async function takeDraft(publisherId: string, id: string) {
  const draft = await repository.findForPublisher(publisherId, id);
  if (!draft) throw new ApiError(404, 'NOT_FOUND', 'That draft is not yours, or is gone');
  return draft;
}

export async function removeDraft(publisherId: string, id: string): Promise<void> {
  const draft = await repository.findForPublisher(publisherId, id);
  if (!draft) throw new ApiError(404, 'NOT_FOUND', 'That draft is not yours, or is gone');
  await repository.remove(id);
}

/** How many whole days a draft has sat untouched. */
export function idleDaysOf(updatedAt: Date, now = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / 86_400_000));
}

export type DeskDraftRow = {
  id: string;
  displayId: string;
  category: string | null;
  title: string | null;
  stepIndex: number;
  stepKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  idleDays: number;
  publisher: DeskDraft['publisher'];
};

export async function deskDrafts(query: DeskDraftsQuery, now = new Date()) {
  const idleBefore = query.idleDays !== undefined ? new Date(now.getTime() - query.idleDays * 86_400_000) : null;
  const { items, total } = await repository.desk(query, idleBefore);
  const rows: DeskDraftRow[] = items.map(({ answers: _answers, publisherId: _publisherId, ...draft }) => ({ ...draft, idleDays: idleDaysOf(draft.updatedAt, now) }));
  return { items: rows, total, page: query.page, pageSize: query.pageSize };
}
