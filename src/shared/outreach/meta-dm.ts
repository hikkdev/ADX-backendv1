import { getEffectiveLeadChannelsConfig, type MetaDmChannelConfig } from '../integrations/integration-config';
import { logger } from '../logging/logger';
import { GRAPH_BASE, graphError, verifyMetaWebhook } from './meta';
import { asArray, asRecord, epochToDate, str, type AdapterDescription, type SendOutcome, type TextSend, type WebhookEvent, type WebhookInput } from './types';

/**
 * Instagram DM and Messenger — the Messenger Platform on the Graph API, one
 * page token each. Replies only (D13): a message goes to a scoped user id
 * the lead handed us by writing first — a DM, a comment on our post
 * (Meta allows one private reply within seven days), a reply to our story.
 * The hub enforces the window; the adapter sends and reads.
 *
 *   Send:    POST /me/messages { recipient: { id }, message: { text }, messaging_type: 'RESPONSE' }
 *   Webhook: object 'instagram' | 'page', entry[].messaging[] (messages, deliveries, reads),
 *            entry[].changes[] with field 'comments' (Instagram) / 'feed' (Page) for comment-to-DM.
 */
export type DmChannel = 'INSTAGRAM' | 'MESSENGER';

type Fetch = typeof fetch;

export function describeMetaDm(cfg: MetaDmChannelConfig | undefined, channel: DmChannel): AdapterDescription {
  const missing = (['pageId', 'accessToken'] as const).filter((f) => !cfg?.[f]).map(String);
  return { configured: missing.length === 0, provider: channel === 'INSTAGRAM' ? 'meta-instagram' : 'meta-messenger', missing };
}

/** Meta's 24-hour window, and the seven days a comment allows a private reply. */
export const DM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COMMENT_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function createMetaDmAdapter(deps: { fetchImpl?: Fetch; config?: () => Promise<{ instagram?: MetaDmChannelConfig | undefined; messenger?: MetaDmChannelConfig | undefined }> } = {}) {
  const fetchImpl: Fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const config =
    deps.config ??
    (async () => {
      const cfg = await getEffectiveLeadChannelsConfig();
      return { instagram: cfg.instagram, messenger: cfg.messenger };
    });

  const cardFor = async (channel: DmChannel) => {
    const cfg = await config();
    return channel === 'INSTAGRAM' ? cfg.instagram : cfg.messenger;
  };

  return {
    async describe(channel: DmChannel): Promise<AdapterDescription> {
      return describeMetaDm(await cardFor(channel), channel);
    },

    async sendText(channel: DmChannel, input: TextSend): Promise<SendOutcome> {
      const cfg = await cardFor(channel);
      const desc = describeMetaDm(cfg, channel);
      if (!desc.configured || !cfg) return { ok: false, code: 'NOT_CONFIGURED', message: `${channel === 'INSTAGRAM' ? 'Instagram' : 'Messenger'} is not configured (${desc.missing.join(', ')} missing)` };
      try {
        const response = await fetchImpl(`${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(cfg.accessToken!)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient: { id: input.to }, message: { text: input.text }, messaging_type: 'RESPONSE' }),
        });
        if (!response.ok) {
          const message = await graphError(response);
          logger.warn('Meta DM refused', { channel, message });
          return { ok: false, code: 'PROVIDER_ERROR', message };
        }
        const data = (await response.json()) as { message_id?: string; recipient_id?: string };
        return { ok: true, providerId: data.message_id ?? null, response: JSON.stringify({ message_id: data.message_id ?? null }) };
      } catch (err) {
        return { ok: false, code: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) };
      }
    },

    /** A private reply to a comment — Instagram's comment-to-DM, Messenger's private reply; the thread is the comment's author. */
    async replyToComment(channel: DmChannel, commentId: string, text: string): Promise<SendOutcome> {
      const cfg = await cardFor(channel);
      const desc = describeMetaDm(cfg, channel);
      if (!desc.configured || !cfg) return { ok: false, code: 'NOT_CONFIGURED', message: `${channel} is not configured` };
      try {
        const response = await fetchImpl(`${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(cfg.accessToken!)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
        });
        if (!response.ok) return { ok: false, code: 'PROVIDER_ERROR', message: await graphError(response) };
        const data = (await response.json()) as { message_id?: string };
        return { ok: true, providerId: data.message_id ?? null, response: null };
      } catch (err) {
        return { ok: false, code: 'PROVIDER_ERROR', message: err instanceof Error ? err.message : String(err) };
      }
    },

    /**
     * One webhook for both: `object` says which. Echoes of our own sends
     * (`is_echo`) are skipped; a story reply carries `reply_to.story`; a
     * comment change carries the commenter as the thread and the comment id
     * as the message id (the hub replies to it privately).
     */
    async parseWebhook(input: WebhookInput, now = new Date()): Promise<WebhookEvent[]> {
      const cfg = await config();
      verifyMetaWebhook(input, [cfg.instagram?.appSecret, cfg.messenger?.appSecret]);
      const body = asRecord(input.body);
      const channel: DmChannel | null = body['object'] === 'instagram' ? 'INSTAGRAM' : body['object'] === 'page' ? 'MESSENGER' : null;
      if (!channel) return [];
      const ownPageIds = new Set([cfg.instagram?.pageId, cfg.messenger?.pageId].filter(Boolean));
      const events: WebhookEvent[] = [];

      for (const entry of asArray(body['entry'])) {
        const e = asRecord(entry);
        for (const item of asArray(e['messaging'])) {
          const m = asRecord(item);
          const sender = str(asRecord(m['sender'])['id']);
          const message = asRecord(m['message']);
          if (sender && Object.keys(message).length > 0) {
            if (message['is_echo'] === true || ownPageIds.has(sender)) continue;
            const mid = str(message['mid']);
            if (!mid) continue;
            const story = asRecord(asRecord(message['reply_to'])['story']);
            const text = str(message['text']) ?? (asArray(message['attachments']).length > 0 ? '[attachment]' : '');
            events.push({
              kind: 'MESSAGE',
              channel,
              providerThreadId: sender,
              providerMessageId: mid,
              from: sender,
              fromName: null,
              text,
              at: epochToDate(m['timestamp'], now),
              source: Object.keys(story).length > 0 ? 'STORY_REPLY' : 'DM',
            });
            continue;
          }
          const delivery = asRecord(m['delivery']);
          for (const mid of asArray(delivery['mids'])) {
            const id = str(mid);
            if (id) events.push({ kind: 'STATUS', channel, providerMessageId: id, status: 'DELIVERED', error: null, at: epochToDate(delivery['watermark'] ?? m['timestamp'], now) });
          }
        }
        for (const change of asArray(e['changes'])) {
          const c = asRecord(change);
          const field = str(c['field']);
          const value = asRecord(c['value']);
          if (field === 'comments' || (field === 'feed' && str(value['item']) === 'comment' && str(value['verb']) === 'add')) {
            const from = asRecord(value['from']);
            const fromId = str(from['id']);
            const commentId = str(value['id']) ?? str(value['comment_id']);
            if (!fromId || !commentId || ownPageIds.has(fromId)) continue;
            events.push({
              kind: 'MESSAGE',
              channel,
              providerThreadId: fromId,
              providerMessageId: `comment:${commentId}`,
              from: fromId,
              fromName: str(from['username']) ?? str(from['name']),
              text: str(value['text']) ?? str(value['message']) ?? '',
              at: epochToDate(value['created_time'] ?? e['time'], now),
              source: 'COMMENT',
            });
          }
        }
      }
      return events;
    },
  };
}

export type MetaDmAdapter = ReturnType<typeof createMetaDmAdapter>;
export const metaDmAdapter: MetaDmAdapter = createMetaDmAdapter();
