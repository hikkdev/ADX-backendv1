import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';

/**
 * One HTTP call to a gateway, over `fetch`, with a ceiling.
 *
 * A gateway that hangs must not hang the request behind it, and one that
 * answers with an error must answer the platform in the gateway's own
 * words — the operator reading the audit row needs "BAD_REQUEST_ERROR: The
 * amount must be at least INR 1.00", not a 500. Secrets are never logged:
 * the headers are the caller's and stay theirs.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GatewayHttpResult = { status: number; json: unknown; text: string };

export const GATEWAY_TIMEOUT_MS = 15_000;

export async function gatewayFetch(
  fetchImpl: FetchLike,
  gateway: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<GatewayHttpResult> {
  const { timeoutMs = GATEWAY_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...rest, signal: controller.signal });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  } catch (err) {
    logger.warn(`${gateway} did not answer`, { url: url.replace(/\?.*$/, ''), cause: err instanceof Error ? err.message : String(err) });
    throw new ApiError(502, 'GATEWAY_FAILED', `${gateway} did not answer. Try again in a moment.`);
  } finally {
    clearTimeout(timer);
  }
}

/** A non-2xx answer, turned into the error the caller can show. */
export function gatewayError(gateway: string, result: GatewayHttpResult, fallback: string): ApiError {
  const body = result.json as { error?: { code?: string; description?: string }; message?: string } | null;
  const description = body?.error?.description ?? body?.message ?? fallback;
  const code = body?.error?.code;
  return new ApiError(502, 'GATEWAY_FAILED', `${gateway}: ${code ? `${code}: ` : ''}${description}`, {
    gateway,
    status: result.status,
  });
}
