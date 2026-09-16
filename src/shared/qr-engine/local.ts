import QRCode from 'qrcode';
import type { QrRenderRequest, QrRenderResult } from './types';

/**
 * The local engine: the `qrcode` package in the house style.
 *
 * What every deployment has and what every printed code falls back to. It
 * knows colours and size; dot shapes, frames and logos are the engine's,
 * and `styled: false` says so.
 */

/** House style — dark teal on white, 2-module quiet zone. The same numbers `qr.image.ts` has always used. */
export const HOUSE_FOREGROUND = '#213333';
export const HOUSE_BACKGROUND = '#FFFFFF';
const MARGIN = 2;

export const LOCAL_DEFAULT_SIZE = 300;
export const LOCAL_MIN_SIZE = 100;
export const LOCAL_MAX_SIZE = 2000;

export function clampLocalSize(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Math.round(raw as number) : LOCAL_DEFAULT_SIZE;
  return Math.min(LOCAL_MAX_SIZE, Math.max(LOCAL_MIN_SIZE, n));
}

export async function renderLocal(request: QrRenderRequest): Promise<QrRenderResult> {
  const color = {
    dark: request.style?.foregroundColor ?? HOUSE_FOREGROUND,
    light: request.style?.backgroundColor ?? HOUSE_BACKGROUND,
  };
  if (request.format === 'svg') {
    const svg = await QRCode.toString(request.content, { type: 'svg', margin: MARGIN, color });
    return { engine: 'LOCAL', format: 'svg', contentType: 'image/svg+xml', body: Buffer.from(svg, 'utf8'), styled: false };
  }
  const png = await QRCode.toBuffer(request.content, {
    type: 'png',
    width: clampLocalSize(request.size),
    margin: MARGIN,
    color,
  });
  return { engine: 'LOCAL', format: 'png', contentType: 'image/png', body: png, styled: false };
}
