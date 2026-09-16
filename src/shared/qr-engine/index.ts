import { ApiError } from '../errors';
import { getEffectiveQrEngineConfig } from '../integrations';
import { logger } from '../logging';
import { deleteGenqrCode, genqrCodeAnalytics, genqrCodeImage, genqrTest, registerGenqrDynamic, renderGenqr } from './genqr';
import { renderLocal } from './local';
import type { DynamicCode, DynamicCodeAnalytics, DynamicCodeRequest, QrEngineName, QrEngineTest, QrRenderRequest, QrRenderResult } from './types';

/**
 * QR-1: the one door every printed code and every hosted dynamic code
 * leaves by.
 *
 * `campaigns` (the hoarding codes), `qr` (the printed identity codes) and
 * the integrations card call this — nothing calls the GenQR client directly,
 * so the switch on the integrations row moves everything at once.
 */

export type { DynamicCode, DynamicCodeAnalytics, DynamicCodeRequest, QrEngineName, QrEngineTest, QrRenderRequest, QrRenderResult, QrRenderFormat, Breakdown } from './types';
export { renderLocal, clampLocalSize, HOUSE_FOREGROUND, HOUSE_BACKGROUND } from './local';
export { GENQR_REQUIRED_SCOPES, GENQR_MAX_BATCH, genqrError } from './genqr';

/** Which engine a printed code is drawn with right now. */
export async function qrEngineInForce(): Promise<QrEngineName> {
  return (await getEffectiveQrEngineConfig()).provider;
}

/** Whether the engine can host dynamic codes — GENQR chosen AND its credentials present. */
export async function dynamicCodesAvailable(): Promise<boolean> {
  const cfg = await getEffectiveQrEngineConfig();
  return cfg.provider === 'GENQR' && Boolean(cfg.baseUrl && cfg.apiKey);
}

/**
 * Draws a code that goes to print.
 *
 * GenQR when it is the engine and answers; LOCAL otherwise — a print job
 * must never fail to draw because a vendor blinked. The fallback is logged,
 * not hidden, and the result's `engine` and `styled` say what came back so
 * a caller can tell a designer whether the frame and logo are in it.
 */
export async function renderPrinted(request: QrRenderRequest): Promise<QrRenderResult> {
  const engine = await qrEngineInForce();
  if (engine === 'GENQR') {
    try {
      return await renderGenqr(request);
    } catch (cause) {
      const reason = cause instanceof ApiError ? `${cause.code}: ${cause.message}` : String(cause);
      logger.warn('QR engine fell back to LOCAL for a printed code', { reason });
    }
  }
  return renderLocal(request);
}

/**
 * Draws a dynamic code the engine hosts. The engine's image encodes the
 * short URL the hoarding carries; when the engine does not answer, the
 * short URL ADX stored at registration is drawn locally — the same URL,
 * plainer artwork — and only a code with no short URL at all is drawn as
 * ADX's own `/t/` link.
 */
export async function renderDynamic(
  code: { engineCodeId: string | null; shortUrl: string | null },
  fallbackContent: string,
  format: 'svg' | 'png',
  size?: number,
): Promise<QrRenderResult> {
  if (code.engineCodeId && (await qrEngineInForce()) === 'GENQR') {
    try {
      return await genqrCodeImage(code.engineCodeId, format, size);
    } catch (cause) {
      const reason = cause instanceof ApiError ? `${cause.code}: ${cause.message}` : String(cause);
      logger.warn('QR engine fell back to LOCAL for a dynamic code', { reason, engineCodeId: code.engineCodeId });
    }
  }
  return renderLocal({ content: code.shortUrl ?? fallbackContent, format, ...(size ? { size } : {}) });
}

/**
 * Mints hosted dynamic codes, one per request, in the order asked. Throws
 * 503 `INTEGRATION_NOT_CONFIGURED` when no engine hosts codes — the caller
 * decides whether that is fatal (it is not for a campaign: the hoarding can
 * carry ADX's own `/t/` link) or a "link later" (the backfill route).
 */
export async function registerDynamicCodes(items: readonly DynamicCodeRequest[]): Promise<DynamicCode[]> {
  if (!(await dynamicCodesAvailable())) {
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'No QR engine is configured to host dynamic codes.');
  }
  return registerGenqrDynamic(items);
}

/** Retires a hosted code on the engine. A code the engine no longer has is not an error. */
export async function retireDynamicCode(engineCodeId: string): Promise<void> {
  if (!(await dynamicCodesAvailable())) return;
  try {
    await deleteGenqrCode(engineCodeId);
  } catch (cause) {
    if (cause instanceof ApiError && cause.statusCode === 404) return;
    throw cause;
  }
}

/**
 * What the engine saw for each hosted code, keyed by engine id. A code the
 * engine cannot answer for is absent, never a throw: the panel is drawn
 * beside ADX's own numbers and a missing panel is the honest answer.
 */
export async function dynamicCodeAnalytics(engineCodeIds: readonly string[], days: number): Promise<Map<string, DynamicCodeAnalytics>> {
  const out = new Map<string, DynamicCodeAnalytics>();
  if (engineCodeIds.length === 0 || !(await dynamicCodesAvailable())) return out;
  await Promise.all(
    engineCodeIds.map(async (id) => {
      try {
        out.set(id, await genqrCodeAnalytics(id, days));
      } catch (cause) {
        const reason = cause instanceof ApiError ? `${cause.code}: ${cause.message}` : String(cause);
        logger.warn('QR engine analytics unavailable for a code', { reason, engineCodeId: id });
      }
    }),
  );
  return out;
}

/** The integrations card's test. LOCAL has nothing to test and says so. */
export async function testQrEngine(): Promise<QrEngineTest> {
  const cfg = await getEffectiveQrEngineConfig();
  if (cfg.provider === 'LOCAL') {
    return {
      engine: 'LOCAL',
      configured: true,
      reachable: true,
      authorized: true,
      status: null,
      message: 'Codes are drawn locally in the house style. Choose GenQR to host dynamic codes and print styled artwork.',
      account: null,
      scopesMissing: [],
      shortBaseMatches: null,
    };
  }
  return genqrTest();
}
