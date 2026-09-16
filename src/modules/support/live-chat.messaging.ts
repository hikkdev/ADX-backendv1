import type { SupportTicket, TicketMessage } from '../../shared/database';
import { ApiError } from '../../shared/errors';
import { getPlatformSettings } from '../app-config';
import { notify } from '../notifications';
import { findUploadedFile } from '../uploads';
import { INBOX_CHANNEL, publish, ticketChannel, type TicketEvent } from './live-chat.bus';

/**
 * What every message on a thread does besides landing in the table — Lot I.
 *
 * A leaf on purpose: `support.service` (the ordinary reply) and
 * `live-chat.service` (the live door, the sweep) both need the attachment
 * rule, the fan-out and the two pushes, and neither may import the other
 * without closing a cycle inside the module.
 */

/** What an attachment may be. The owner's default: images and PDF, up to `support.liveChat.attachmentMaxMb`. */
export const ATTACHMENT_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

export type ResolvedAttachment = { fileId: string; name: string };

/**
 * The file on a message, checked before it can be named.
 *
 * It has to exist, it has to be the caller's own (uploaded by them, or filed
 * for them), it has to have been uploaded as a SUPPORT_ATTACHMENT — the
 * private purpose whose door `uploads` opens to the thread's other side —
 * and it has to be an image or a PDF under the cap. A file that fails any
 * of those is a 400, not a message with a broken paperclip on it.
 */
export async function resolveAttachment(fileId: string, callerUserId: string): Promise<ResolvedAttachment> {
  const file = await findUploadedFile(fileId);
  if (!file) throw new ApiError(404, 'NOT_FOUND', 'That attachment does not exist');
  const owner = file.ownerUserId ?? file.userId;
  if (owner !== callerUserId && file.userId !== callerUserId) {
    throw new ApiError(403, 'FORBIDDEN', 'That attachment is not yours');
  }
  if (file.purpose !== 'SUPPORT_ATTACHMENT') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Upload the file with purpose SUPPORT_ATTACHMENT before attaching it', { purpose: file.purpose });
  }
  if (!ATTACHMENT_MIME.includes(file.mimeType)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'An attachment is an image or a PDF', { mimeType: file.mimeType });
  }
  const { support } = await getPlatformSettings();
  const maxBytes = support.liveChat.attachmentMaxMb * 1024 * 1024;
  if (file.sizeBytes > maxBytes) {
    throw new ApiError(400, 'VALIDATION_ERROR', `An attachment is at most ${support.liveChat.attachmentMaxMb} MB`, { sizeBytes: file.sizeBytes });
  }
  return { fileId: file.id, name: file.filename };
}

/** The message as the stream sends it. `mine` is decided per viewer by the stream, not here. */
export function messageEvent(message: TicketMessage): TicketEvent {
  return {
    type: 'message',
    id: message.id,
    authorId: message.authorId,
    authorName: message.authorName,
    kind: message.kind,
    message: message.message,
    attachment: message.attachmentFileId ? { fileId: message.attachmentFileId, name: message.attachmentName ?? 'attachment' } : null,
    internal: message.internal,
    createdAt: message.createdAt.toISOString(),
  };
}

const preview = (text: string, limit = 140): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** Fans a message out to the thread, and — on a live chat — to the desk's inbox. */
export async function publishMessage(ticket: Pick<SupportTicket, 'id' | 'displayId' | 'channel' | 'assignedAdminUserId'>, message: TicketMessage): Promise<void> {
  await publish(ticketChannel(ticket.id), messageEvent(message));
  // An internal note is ops talking to ops: it never reaches the inbox row
  // the desk reads as "the requester said something".
  if (ticket.channel !== 'LIVE_CHAT' || message.internal) return;
  await publish(INBOX_CHANNEL, {
    type: 'message',
    ticketId: ticket.id,
    displayId: ticket.displayId,
    assignedAdminUserId: ticket.assignedAdminUserId,
    authorName: message.authorName,
    preview: preview(message.kind === 'ATTACHMENT' ? (message.attachmentName ?? 'Attachment') : message.message, 80),
  });
}

/**
 * ADX answered: the in-app MESSAGE row the feed has always shown, and now a
 * push beside it (SUPPORT_REPLY, transactional — a reply on your own ticket
 * is about your own account and leaves whenever it is written).
 */
export async function notifyRequesterOfReply(
  ticket: Pick<SupportTicket, 'id' | 'userId' | 'displayId' | 'title'>,
  message: Pick<TicketMessage, 'message' | 'kind' | 'attachmentName' | 'authorName'>,
): Promise<void> {
  const body = message.kind === 'ATTACHMENT' ? (message.attachmentName ?? 'Attachment') : message.message;
  await notify(
    'SUPPORT_REPLY',
    ticket.userId,
    { ticketRef: ticket.displayId ?? ticket.title, preview: preview(body), author: message.authorName },
    {
      type: 'MESSAGE',
      inApp: {
        type: 'MESSAGE',
        title: 'ADX Support replied',
        ...(ticket.displayId ? { subtitle: ticket.displayId } : {}),
        message: preview(body),
        relatedId: ticket.id,
        relatedType: 'TICKET',
      },
    },
  );
}

/** The requester answered on a chat somebody owns: their operator hears it, in-app and on the phone. */
export async function notifyOperatorOfRequesterMessage(
  ticket: Pick<SupportTicket, 'id' | 'displayId' | 'title' | 'assignedAdminUserId'>,
  message: Pick<TicketMessage, 'message' | 'kind' | 'attachmentName' | 'authorName'>,
): Promise<void> {
  if (!ticket.assignedAdminUserId) return;
  const body = message.kind === 'ATTACHMENT' ? (message.attachmentName ?? 'Attachment') : message.message;
  await notify(
    'SUPPORT_MESSAGE_FROM_REQUESTER',
    ticket.assignedAdminUserId,
    { ticketRef: ticket.displayId ?? ticket.title, requesterName: message.authorName, preview: preview(body) },
    {
      type: 'MESSAGE',
      inApp: {
        type: 'MESSAGE',
        title: `${message.authorName} replied`,
        ...(ticket.displayId ? { subtitle: ticket.displayId } : {}),
        message: preview(body),
        relatedId: ticket.id,
        relatedType: 'TICKET',
      },
    },
  );
}
