import type { QrEngineProvider, QrEngineStyle } from '../integrations';

/**
 * QR-1: the QR engine port.
 *
 * Two things ADX wants from a QR engine, and one it must never hand over.
 *
 *   - **Drawing.** Every code that goes to print — a hoarding's tracking
 *     code, a listing's site plaque, an agent's referral card, a pickup
 *     label — wants the house style: colours, dot shape, a frame with a
 *     caption, the logo in the middle. `render` answers that for content
 *     the caller already owns; nothing is stored by the engine.
 *   - **Hosting a dynamic code.** A campaign's hoarding carries a short URL
 *     the engine owns; the engine records the scan (geo, device, browser)
 *     and 302s to ADX's own `/t/:code`, which records it again and sends the
 *     person on. `registerDynamic` mints those; `codeAnalytics` reads what
 *     the engine saw, which the analytics screen draws BESIDE ADX's own
 *     number and labels as the engine's — never in its place.
 *   - **Never**: the signed onboarding and grant tokens the `qr` module
 *     mints. They live ninety seconds on a phone screen and their signature
 *     is the platform's; they are drawn locally and do not leave ADX.
 *
 * `LOCAL` is the `qrcode` package in the house style — every deployment has
 * it, and it is what every printed code falls back to when the engine is
 * not configured or does not answer, because a print job must never fail to
 * draw. `GENQR` is our own QR platform, reached over its public API.
 */

export type QrEngineName = QrEngineProvider;

export type QrRenderFormat = 'svg' | 'png';

export type QrRenderRequest = {
  content: string;
  format: QrRenderFormat;
  /** Pixel width of a PNG, 100..2000; an SVG scales. */
  size?: number;
  /** Per-call overrides on the engine's stored style — a caption naming the spot, say. */
  style?: QrEngineStyle;
};

export type QrRenderResult = {
  engine: QrEngineName;
  format: QrRenderFormat;
  contentType: 'image/svg+xml' | 'image/png';
  body: Buffer;
  /**
   * Whether the document carries the full style. GenQR's SVG does; its PNG
   * and everything LOCAL draws honour colours and size only, and the caller
   * should not tell a print designer otherwise.
   */
  styled: boolean;
};

export type DynamicCodeRequest = {
  /** The engine's name for the code — the campaign and spot, for the desk on the other side. */
  name: string;
  /** Where the engine sends a scan: ADX's own `/t/:code`. */
  target: string;
};

export type DynamicCode = {
  /** The engine's id for the code, stored so analytics and images can be fetched. */
  engineCodeId: string;
  shortCode: string;
  /** The printed URL — the ADX-branded short origin plus `/r/<shortCode>`. */
  shortUrl: string;
};

export type Breakdown = { label: string; count: number }[];

export type DynamicCodeAnalytics = {
  engineCodeId: string;
  days: number;
  totalScans: number;
  scansInWindow: number;
  scansByDay: { date: string; count: number }[];
  hourlyBreakdown: { hour: number; count: number }[];
  deviceBreakdown: Breakdown;
  browserBreakdown: Breakdown;
  osBreakdown: Breakdown;
  countryBreakdown: { label: string; code: string | null; count: number }[];
  cityBreakdown: Breakdown;
};

/** The verdict the integrations card prints — never a key. */
export type QrEngineTest = {
  engine: QrEngineName;
  configured: boolean;
  reachable: boolean;
  authorized: boolean;
  status: number | null;
  message: string;
  account: {
    email: string;
    plan: string;
    apiAccess: boolean;
    scope: string;
    redirectBase: string;
  } | null;
  /** The scopes the key lacks for the whole integration, so ops know what to add on GenQR. */
  scopesMissing: string[];
  /** Whether GenQR's redirect base matches the short base ADX prints — a mismatch means the hoarding says one host and GenQR another. */
  shortBaseMatches: boolean | null;
};
