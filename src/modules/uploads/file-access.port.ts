/**
 * Who else may open a private file — Lot D (Q61).
 *
 * The owner and an admin are decided here. The third reader — the party's
 * agent under a live grant — needs `agents`, `access-grants`, `publishers`
 * and `advertisers`, and `uploads` sits underneath all of them (`payouts`
 * and `invoices` store files, and `publishers` reaches `payouts`), so it
 * cannot import them without closing a cycle. The question is declared here
 * as a port and answered in `bootstrap/register-modules.ts`.
 *
 * Unregistered, the answer is no: a file nobody wired the port for is
 * private to its owner and the desk, never accidentally open.
 */
export interface FileAccessPort {
  /**
   * Is `viewerUserId` an agent holding a live PROFILE grant on the party
   * `ownerUserId` belongs to? Answers the read (`GET /files/:id`) and — Lot F —
   * the on-behalf upload (`POST /upload` naming `ownerUserId`): a live grant
   * is the write authority every on-behalf write asks for.
   */
  agentMayView(viewerUserId: string, ownerUserId: string): Promise<boolean>;
  /**
   * Lot F: is `viewerUserId` a party to a dispute the DISPUTE_EVIDENCE file
   * `fileId` is attached to — the raiser, the party it is against — or that
   * party's agent under a live grant? `holders` are the file's own people
   * (its owner and its uploader): only a case one of them is a party to
   * counts, so a stranger cannot attach somebody else's file to a case of
   * their own and read it. Optional: unregistered, only the owner and the
   * desk open evidence.
   */
  disputePartyMayView?(viewerUserId: string, fileId: string, holders: readonly string[]): Promise<boolean>;
  /**
   * Lot I: is `viewerUserId` the other side of the support thread the
   * SUPPORT_ATTACHMENT file `fileId` sits on — the ticket's requester when
   * ADX attached it (an ADMIN is admitted before the port is asked)? A file
   * on no message opens to nobody but its owner and the desk. Optional:
   * unregistered, the answer is no.
   */
  supportPartyMayView?(viewerUserId: string, fileId: string): Promise<boolean>;
  /**
   * ST-2 (28 Sep 2026): may `viewerUserId` open the LISTING_DOCUMENT file
   * `fileId` because of the listing it is filed on? True when a listing's
   * document (`ListingDocument.url`) names the file, by `/files/:id` or by
   * the public URL it had before it was adopted, and the viewer is that
   * listing's publisher, a field agent sent to that listing (an open or
   * recent site visit, verification milestone or order of theirs on it), or
   * an agent holding a live PROFILE grant on the publisher. Asked after the
   * owner, the desk and the grant on the file's own owner. Optional:
   * unregistered, the answer is no — the file stays its owner's and the
   * desk's.
   */
  listingDocumentMayView?(viewerUserId: string, fileId: string): Promise<boolean>;
}

let port: FileAccessPort | null = null;

export function registerFileAccessPort(implementation: FileAccessPort): void {
  port = implementation;
}

export async function agentMayViewFile(viewerUserId: string, ownerUserId: string): Promise<boolean> {
  if (!port) return false;
  return port.agentMayView(viewerUserId, ownerUserId);
}

export async function disputePartyMayViewFile(viewerUserId: string, fileId: string, holders: readonly string[]): Promise<boolean> {
  if (!port?.disputePartyMayView) return false;
  return port.disputePartyMayView(viewerUserId, fileId, holders);
}

export async function supportPartyMayViewFile(viewerUserId: string, fileId: string): Promise<boolean> {
  if (!port?.supportPartyMayView) return false;
  return port.supportPartyMayView(viewerUserId, fileId);
}

export async function listingDocumentMayViewFile(viewerUserId: string, fileId: string): Promise<boolean> {
  if (!port?.listingDocumentMayView) return false;
  return port.listingDocumentMayView(viewerUserId, fileId);
}
