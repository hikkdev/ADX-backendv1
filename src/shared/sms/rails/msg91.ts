import { getEffectiveSmsConfig } from '../../integrations/integration-config';
import { logger } from '../../logging/logger';
import { pickVars, toE164, type DeliveryReport, type DeliveryWebhookInput, type SmsRail, type SmsSendRequest, type SmsSendResult } from '../rail';

/**
 * MSG91 — the Flow API. Docs: https://docs.msg91.com/reference/send-sms
 *
 * A flow is MSG91's name for a DLT template it has on file: the request names
 * the flow by id and posts the variables by name, and MSG91 renders the
 * registered text itself. That is what makes this rail DLT-clean — the old
 * single-template send put the whole message in `var1`, which the operator
 * rejects as soon as the text stops matching the registration.
 *
 * The success body is `{ type: 'success', message: '<request id>' }`; the
 * request id is what the delivery report later carries.
 */

const FLOW_URL = 'https://control.msg91.com/api/v5/flow';

/**
 * MSG91 delivery status codes, from its DLR reference. 1 is the only
 * delivered; the pending family (5 submitted, 6 in progress, 25 sent to the
 * operator) is still in flight; everything else is a failure of some kind —
 * DND, NDNC, blocked, rejected, expired.
 */
function statusFromCode(code: number | string | undefined): DeliveryReport['status'] {
  const n = typeof code === 'string' ? Number.parseInt(code, 10) : code;
  if (n === 1) return 'DELIVERED';
  if (n === 5 || n === 6 || n === 25) return 'SENT';
  return 'FAILED';
}

type Fetch = typeof fetch;

export function createMsg91Rail(deps: { fetchImpl?: Fetch } = {}): SmsRail {
  const fetchImpl: Fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    name: 'msg91',

    async describe() {
      const { authKey } = await getEffectiveSmsConfig();
      return { configured: Boolean(authKey) };
    },

    async send(request: SmsSendRequest): Promise<SmsSendResult> {
      const { authKey } = await getEffectiveSmsConfig();
      if (!authKey) throw new Error('MSG91 is not configured');

      const body = {
        template_id: request.registration.templateId,
        short_url: '0',
        ...(request.dlt.senderId ? { sender: request.dlt.senderId } : {}),
        recipients: [
          {
            // MSG91 wants the country code without the plus.
            mobiles: toE164(request.to).slice(1),
            ...pickVars(request.registration, request.vars),
          },
        ],
      };

      const response = await fetchImpl(FLOW_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authkey: authKey },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error('MSG91 send failed', { kind: request.kind, status: response.status, body: text });
        throw new Error(`SMS delivery failed: ${response.status}`);
      }

      const data = (await response.json()) as { type?: string; message?: string };
      if (data.type === 'error') {
        logger.error('MSG91 error response', { kind: request.kind, data });
        throw new Error(`SMS delivery error: ${data.message ?? 'unknown'}`);
      }

      logger.info('SMS sent via MSG91', { kind: request.kind });
      return { providerMessageId: data.message ?? null, responseText: JSON.stringify(data).slice(0, 1000) };
    },

    /**
     * MSG91 posts delivery reports as a JSON array (or `{ data: [...] }`),
     * one entry per request id, each with a `report` array per number. There
     * is no signature to check; the row is matched on the request id we were
     * given at send time, so a forged report can at most mark a message we
     * did send as delivered or failed.
     */
    async parseDeliveryWebhook(input: DeliveryWebhookInput): Promise<DeliveryReport[]> {
      const raw = input.body as { data?: unknown } | unknown[] | null;
      const entries: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : raw ? [raw] : [];
      const reports: DeliveryReport[] = [];

      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const requestId = (e['requestId'] ?? e['request_id'] ?? e['reqId']) as string | undefined;
        if (!requestId) continue;

        const perNumber = Array.isArray(e['report']) ? (e['report'] as Record<string, unknown>[]) : [e];
        for (const r of perNumber) {
          const status = statusFromCode(r['status'] as number | string | undefined);
          const desc = (r['desc'] ?? r['description']) as string | undefined;
          const when = (r['date'] ?? r['deliveredAt']) as string | undefined;
          reports.push({
            providerMessageId: String(requestId),
            status,
            ...(status === 'FAILED' && desc ? { error: desc } : {}),
            ...(when && !Number.isNaN(Date.parse(when)) ? { at: new Date(when) } : {}),
          });
        }
      }

      return reports;
    },
  };
}

export const msg91Rail: SmsRail = createMsg91Rail();
