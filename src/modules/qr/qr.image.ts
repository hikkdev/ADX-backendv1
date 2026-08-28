import QRCode from 'qrcode';

/** House style for every rendered code — dark teal on white, 2-module quiet zone. */
const STYLE = { margin: 2, color: { dark: '#213333', light: '#FFFFFF' } } as const;

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
