import crypto from 'crypto';
import { getEffectiveCcavenueConfig, type CcavenueConfig } from '../../../shared/integrations';
import { money } from '../../../shared/money';
import type {
  CreateOrderInput,
  CreateOrderResult,
  FetchedPayment,
  GatewayAdapter,
  GatewayPaymentStatus,
  GatewayReadiness,
  ParsedWebhook,
  RefundInput,
  RefundResult,
  WebhookRequest,
} from './gateway';
import { gatewayError, gatewayFetch, type FetchLike } from './http';

/**
 * CCAvenue — an adapter in test mode until its credentials arrive (Q110).
 *
 * CCAvenue is a redirect flow with no JSON API for the checkout: the merchant
 * builds a `key=value&…` request, encrypts it, and the browser posts it with
 * the access code to CCAvenue's transaction page. CCAvenue posts an
 * `encResp` back to the redirect / cancel URL — that callback is the
 * platform's webhook, and it is authenticated by the fact that it decrypts
 * under the working key into a record naming our order.
 *
 *   Crypto      AES-128-CBC, key = MD5(working key), IV = 0x00…0x0f, hex out
 *               — CCAvenue's integration kit, byte for byte.
 *   Status      DoWebTrans command=orderStatusTracker, enc_request = the
 *               encrypted JSON { order_no, reference_no }.
 *   Refund      DoWebTrans command=refundOrder, { reference_no, refund_amount,
 *               refund_ref_no }; refund_status 0 is success.
 *
 * Test mode targets test.ccavenue.com / apitest.ccavenue.com; live is
 * secure.ccavenue.com / api.ccavenue.com.
 */

export const CCAVENUE_HOSTS = {
  test: { transaction: 'https://test.ccavenue.com', api: 'https://apitest.ccavenue.com' },
  live: { transaction: 'https://secure.ccavenue.com', api: 'https://api.ccavenue.com' },
} as const;

const IV = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]);

const keyFor = (workingKey: string): Buffer => crypto.createHash('md5').update(workingKey, 'utf8').digest();

/** CCAvenue's encrypt: AES-128-CBC over MD5(working key) with the fixed IV, hex. */
export function ccavenueEncrypt(plain: string, workingKey: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', keyFor(workingKey), IV);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('hex');
}

/** The inverse. Throws on ciphertext that does not decrypt under this key. */
export function ccavenueDecrypt(hex: string, workingKey: string): string {
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyFor(workingKey), IV);
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8');
}

const orderStatus = (status: string | undefined): GatewayPaymentStatus => {
  const value = (status ?? '').toLowerCase();
  if (value === 'success' || value === 'successful' || value === 'shipped') return 'CAPTURED';
  if (value === 'refunded') return 'REFUNDED';
  if (value === 'initiated' || value === 'awaited' || value === '') return 'CREATED';
  return 'FAILED';
};

/** `a=1&b=2` into a record; a body that is not that shape yields an empty record. */
const parseKv = (plain: string): Record<string, string> => Object.fromEntries(new URLSearchParams(plain));

export function createCcavenueAdapter(
  loadConfig: () => Promise<CcavenueConfig> = getEffectiveCcavenueConfig,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): GatewayAdapter {
  const hosts = (cfg: CcavenueConfig) => ((cfg.testMode ?? true) ? CCAVENUE_HOSTS.test : CCAVENUE_HOSTS.live);

  async function readiness(): Promise<GatewayReadiness> {
    const cfg = await loadConfig();
    const missing = (['merchantId', 'accessCode', 'workingKey'] as const).filter((key) => !cfg[key]);
    return { configured: missing.length === 0, testMode: cfg.testMode ?? true, missing };
  }

  /** One DoWebTrans call: the JSON encrypted in, the JSON decrypted out. */
  async function webTrans(cfg: CcavenueConfig, command: 'orderStatusTracker' | 'refundOrder', request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const form = new URLSearchParams({
      enc_request: ccavenueEncrypt(JSON.stringify(request), cfg.workingKey ?? ''),
      access_code: cfg.accessCode ?? '',
      command,
      request_type: 'JSON',
      response_type: 'JSON',
      version: '1.2',
    });
    const result = await gatewayFetch(fetchImpl, 'CCAvenue', `${hosts(cfg).api}/apis/servlet/DoWebTrans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (result.status < 200 || result.status >= 300) throw gatewayError('CCAvenue', result, `${command} failed`);
    const answer = new URLSearchParams(result.text);
    const encResponse = answer.get('enc_response');
    if (answer.get('status') !== '0' || !encResponse) {
      throw gatewayError('CCAvenue', result, answer.get('enc_response') ?? `${command} was refused (status ${answer.get('status') ?? '?'})`);
    }
    try {
      return JSON.parse(ccavenueDecrypt(encResponse, cfg.workingKey ?? '')) as Record<string, unknown>;
    } catch {
      throw gatewayError('CCAvenue', result, `${command} answered something that does not decrypt`);
    }
  }

  return {
    name: 'CCAVENUE',
    readiness,

    /** No network call: the "order" is the encrypted request the browser carries to CCAvenue. */
    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      const cfg = await loadConfig();
      const fields = new URLSearchParams({
        merchant_id: cfg.merchantId ?? '',
        order_id: input.paymentId,
        currency: input.currency,
        amount: money(input.amount),
        redirect_url: input.notifyUrl,
        cancel_url: input.notifyUrl,
        language: 'EN',
        billing_name: input.customer.name.slice(0, 60),
        ...(input.customer.mobile ? { billing_tel: input.customer.mobile.replace(/^\+?91/, '').replace(/\D/g, '') } : {}),
        ...(input.customer.email ? { billing_email: input.customer.email } : {}),
        merchant_param1: input.reference,
        merchant_param2: input.customer.id,
      });
      return {
        gatewayOrderId: input.paymentId,
        checkout: {
          encRequest: ccavenueEncrypt(fields.toString(), cfg.workingKey ?? ''),
          accessCode: cfg.accessCode,
          redirectUrl: `${hosts(cfg).transaction}/transaction/transaction.do?command=initiateTransaction`,
          returnUrl: input.returnUrl,
        },
      };
    },

    /** The app hands back the encResp it was redirected with; it has to decrypt and name our order and tracking id. */
    async verifySignature({ gatewayOrderId, gatewayPaymentId, signature }): Promise<boolean> {
      const cfg = await loadConfig();
      if (!cfg.workingKey) return false;
      try {
        const fields = parseKv(ccavenueDecrypt(signature.trim(), cfg.workingKey));
        return fields['order_id'] === gatewayOrderId && fields['tracking_id'] === gatewayPaymentId;
      } catch {
        return false;
      }
    },

    async fetchPayment(gatewayPaymentId: string, gatewayOrderId: string | null): Promise<FetchedPayment> {
      const cfg = await loadConfig();
      const answer = await webTrans(cfg, 'orderStatusTracker', { order_no: gatewayOrderId ?? '', reference_no: gatewayPaymentId });
      const status = orderStatus(answer['order_status'] as string | undefined);
      return {
        gatewayPaymentId: String(answer['reference_no'] ?? gatewayPaymentId),
        gatewayOrderId: String(answer['order_no'] ?? gatewayOrderId ?? ''),
        status,
        amount: money(Number(answer['order_amt'] ?? 0)),
        currency: String(answer['order_currncy'] ?? 'INR'),
        method: (answer['order_card_name'] as string | undefined) ?? null,
        failureReason: status === 'FAILED' ? String(answer['order_fail_message'] || answer['order_status'] || 'Failed') : null,
        raw: answer,
      };
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const cfg = await loadConfig();
      const answer = await webTrans(cfg, 'refundOrder', { reference_no: input.gatewayPaymentId, refund_amount: money(input.amount), refund_ref_no: input.refundId });
      const ok = String(answer['refund_status']) === '0';
      return { gatewayRefundId: input.refundId, status: ok ? 'PROCESSED' : 'FAILED', raw: answer };
    },

    /**
     * The encResp CCAvenue posts to the redirect URL. There is no HMAC: the
     * record is trusted because it decrypts under the working key into a
     * `key=value&…` body that names an order — anything else is MISMATCH.
     */
    async parseWebhook(request: WebhookRequest): Promise<ParsedWebhook> {
      const cfg = await loadConfig();
      if (!cfg.workingKey) return { ok: false, reason: 'NO_SECRET' };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const encResp = typeof body['encResp'] === 'string' ? body['encResp'] : typeof body['encResponse'] === 'string' ? body['encResponse'] : null;
      if (!encResp) return { ok: false, reason: 'NO_SIGNATURE' };

      let fields: Record<string, string>;
      try {
        fields = parseKv(ccavenueDecrypt(encResp, cfg.workingKey));
      } catch {
        return { ok: false, reason: 'MISMATCH' };
      }
      const orderId = fields['order_id'];
      if (!orderId) return { ok: false, reason: 'MISMATCH' };

      const trackingId = fields['tracking_id'] || null;
      const status = orderStatus(fields['order_status']);
      return {
        ok: true,
        payload: fields,
        event: {
          eventId: `${orderId}:${trackingId ?? 'none'}:${fields['order_status'] ?? 'unknown'}`,
          eventType: `ccavenue.${(fields['order_status'] ?? 'unknown').toLowerCase()}`,
          kind: 'PAYMENT',
          gatewayOrderId: orderId,
          gatewayPaymentId: trackingId,
          gatewayRefundId: null,
          status,
          refundStatus: null,
          amount: fields['amount'] ? money(fields['amount']) : null,
          method: fields['payment_mode'] || null,
          failureReason: status === 'FAILED' ? fields['failure_message'] || fields['status_message'] || fields['order_status'] || 'Failed' : null,
        },
      };
    },
  };
}
