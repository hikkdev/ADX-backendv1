import QRCode from 'qrcode';
import type { QrType } from '../../shared/database';
import { renderPrinted, type QrRenderResult } from '../../shared/qr-engine';
import { identityContent, isIdentityType } from './qr.service';

/** House style for every rendered code — dark teal on white, 2-module quiet zone. */
const STYLE = { margin: 2, color: { dark: '#213333', light: '#FFFFFF' } } as const;

/**
 * QR-1: which code types go to print, and so through the QR engine for the
 * styled artwork — a listing's site plaque, an agent's referral card, an
 * order's pickup label, an ad's health code. The rest — the ninety-second
 * onboarding and access-grant codes — live on a phone screen, are drawn
 * here in the house style, and their signed token never leaves ADX.
 */
export const PRINTED_QR_TYPES: readonly QrType[] = ['SITE', 'AGENT', 'ORDER', 'AD'];

export function isPrintedType(type: QrType): boolean {
  return PRINTED_QR_TYPES.includes(type);
}

/**
 * The image of a code, by its type: printed types through the engine
 * (which falls back to the house style on its own), the rest locally.
 * The caption names what the code is for, so a frame on the print says it.
 */
export async function renderQrImage(
  qr: { type: QrType; token: string },
  format: 'png' | 'svg',
  size: number,
  caption?: string,
): Promise<QrRenderResult> {
  if (isPrintedType(qr.type)) {
    return renderPrinted({ content: qr.token, format, size, ...(caption ? { style: { frameCaption: caption } } : {}) });
  }
  // QR-27: an identity code carries the `/q/<token>` link so a plain camera can open it.
  const content = isIdentityType(qr.type) ? identityContent(qr.token) : qr.token;
  const body = format === 'png' ? await toPngBuffer(content, size) : Buffer.from(await toSvg(content), 'utf8');
  return { engine: 'LOCAL', format, contentType: format === 'png' ? 'image/png' : 'image/svg+xml', body, styled: false };
}

export const IMAGE_CACHE_CONTROL = 'public, max-age=86400';

/** Clamps a requested pixel size to 100..1000, defaulting to 300. */
export function clampSize(raw: unknown): number {
  return Math.min(Math.max(parseInt((raw as string) ?? '300', 10), 100), 1000);
}

export function toPngBuffer(token: string, size: number): Promise<Buffer> {
  return QRCode.toBuffer(token, { type: 'png', width: size, ...STYLE });
}

export function toSvg(token: string): Promise<string> {
  return QRCode.toString(token, { type: 'svg', ...STYLE });
}

export function toDataUrl(token: string): Promise<string> {
  return QRCode.toDataURL(token, { type: 'image/png', width: 300, ...STYLE });
}
