import type { ListingDraft } from '../../shared/database';
import type { DeskDraftsQuery, SaveDraftInput } from './drafts.schema';

/** QR-8: a draft with its publisher, as the desk lists it. */
export type DeskDraft = ListingDraft & {
  publisher: { id: string; displayId: string | null; name: string; mobile: string; city: string | null; kycStatus: string };
};

export interface DraftsRepository {
  listForPublisher(publisherId: string): Promise<ListingDraft[]>;
  findForPublisher(publisherId: string, id: string): Promise<ListingDraft | null>;
  create(publisherId: string, displayId: string, input: SaveDraftInput): Promise<ListingDraft>;
  update(id: string, input: SaveDraftInput): Promise<ListingDraft>;
  remove(id: string): Promise<unknown>;
  desk(query: DeskDraftsQuery, idleBefore: Date | null): Promise<{ items: DeskDraft[]; total: number }>;
}
