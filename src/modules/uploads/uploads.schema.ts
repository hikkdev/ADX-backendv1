import { z } from 'zod';

export const purposeSchema = z.enum([
  'KYC',
  /// D4: an agent's documents, recorded by the admin at the desk.
  'AGENT_KYC',
  /// Lot D (Q61): an advertiser's, an employee's, and the liveness video.
  'ADVERTISER_KYC',
  'EMPLOYEE_KYC',
  'USER_KYC',
  /// Lot N: a print partner's KYC documents — private, the partner's own or recorded at the desk on their behalf.
  'PRINT_PARTNER_KYC',
  /// Lot D: what a party attaches to a dispute.
  'DISPUTE_EVIDENCE',
  'LISTING_PHOTO',
  /// Site-visit, re-verification and installation proof photos, and — until ST-2 adopts them — the papers filed on a listing. Public.
  'VERIFICATION',
  /// ST-2 (28 Sep 2026): a listing's venue papers and audience reports — private; adopted from any public upload when filed on a listing.
  'LISTING_DOCUMENT',
  /// ST-2: a photo an agent or a publisher files on an order (pickup, condition, installed) — public, like the other proof photos.
  'ORDER_EVIDENCE',
  'AVATAR',
  /// QR-9: a brand file the console uploads — the wordmark, the mark, the icon. Public.
  'BRANDING',
  /** LM-1: the media library — layout blocks, tiles, ad artwork. Public. */
  'MEDIA',
  /// Campaign artwork: a print-ready image, or a video for a digital screen.
  'CAMPAIGN_CREATIVE',
  /// Lot B (Q41): the proof behind a wallet top-up — a transfer receipt, a cheque scan.
  'TOPUP_PROOF',
  /// Lot B (Q85): the bank bulk-transfer file a payout batch wrote at release.
  'PAYOUT_EXPORT',
  /// Lot B (Q85): a bank statement as imported for reconciliation.
  'BANK_STATEMENT',
  /// Lot B (Q13): a rendered tax invoice, proforma or credit note — and a
  /// GST-registered publisher's own invoice to ADX.
  'INVOICE',
  /// Lot B (Q13): a publisher's monthly payment advice.
  'STATEMENT',
  /// Lot G (Q129): a rendered report run — CSV or PDF — read only by an admin or a signed link.
  'REPORT',
  /// G6 (Q104): a person's own data export — the zip, owned by them, seven days.
  'DATA_EXPORT',
  /// G6 (Q110): a publisher's booking report PDF, owned by the publisher.
  'BOOKING_REPORT',
  /// Lot H (Q147): a print partner's rate card and their monthly invoice to ADX — private, the partner's own.
  'PARTNER_RATE_CARD',
  'PARTNER_INVOICE',
  /// Lot I: an image or PDF on a support message — private; the ticket's other side opens it.
  'SUPPORT_ATTACHMENT',
  /// DS-1 (Digio eSign): the rendered agreement, its signed copy and the audit certificate — private, the signer's own.
  'SIGNED_AGREEMENT',
  /// LH4 (the Lead Hunt): a wall or a shop front an agent photographed in the street — private, kept for the listing draft.
  'LEAD_CAPTURE',
  /// LH6 (D5): a consented call recording — private, the desk's and the agent's, purged after 90 days.
  'CALL_RECORDING',
  /// LH10: the photo an agent takes when they mark a field visit done — private, what the QA draw reads.
  'VISIT_PROOF',
  /// VA-2: a competitor's hoarding an agent photographed in the street — private; the analysis and training corpus read it.
  'COMPETITOR_CAPTURE',
  /// FM-1 (27 Sep 2026): a file answered on a SIGNED_IN form — private, the person's own; the desk reads it from the submission.
  'FORM_UPLOAD',
  'OTHER',
]);

export type UploadPurpose = z.infer<typeof purposeSchema>;

/**
 * Lot D (Q61/Q127): the purposes whose files are never handed a public URL.
 * Identity documents, the proof behind money, what a dispute is argued with
 * and a tax invoice are read only through `GET /files/:id`, by the owner,
 * the party's agent under a live grant, or an admin.
 */
export const PRIVATE_PURPOSES: ReadonlySet<UploadPurpose> = new Set<UploadPurpose>([
  'KYC',
  'AGENT_KYC',
  'ADVERTISER_KYC',
  'EMPLOYEE_KYC',
  'USER_KYC',
  'PRINT_PARTNER_KYC',
  'TOPUP_PROOF',
  'DISPUTE_EVIDENCE',
  'INVOICE',
  'REPORT',
  'DATA_EXPORT',
  'BOOKING_REPORT',
  'PARTNER_RATE_CARD',
  'PARTNER_INVOICE',
  'SUPPORT_ATTACHMENT',
  'SIGNED_AGREEMENT',
  'LEAD_CAPTURE',
  'CALL_RECORDING',
  'VISIT_PROOF',
  'COMPETITOR_CAPTURE',
  'FORM_UPLOAD',
  /*
   * ST-2 (28 Sep 2026): a listing's venue papers — the permit, the owner's
   * NOC, the lease — and its audience reports (BARC, footfall audits). The
   * owner: "Sure, go ahead, build it." Read by the publisher, the desk, the
   * publisher's agent under a live grant, and the field agent sent to that
   * listing (`FileAccessPort.listingDocumentMayView`). Filed under its own
   * purpose rather than VERIFICATION, which also carries the installation
   * and site-visit photos an advertiser is shown and so stays public: a file
   * named on a listing's document is ADOPTED into this purpose when the
   * document is filed (`adoptListingDocument`), whatever it was uploaded as.
   */
  'LISTING_DOCUMENT',
]);

export const isPrivatePurpose = (purpose: string): boolean => PRIVATE_PURPOSES.has(purpose as UploadPurpose);

/** Opening one of these is itself an event on the trail: FILE_VIEWED. */
export const KYC_PURPOSES: ReadonlySet<string> = new Set(['KYC', 'AGENT_KYC', 'ADVERTISER_KYC', 'EMPLOYEE_KYC', 'USER_KYC', 'PRINT_PARTNER_KYC']);

/** Destination folder per purpose. Unknown purposes fall back to 'misc'. */
export const PURPOSE_FOLDER: Record<string, string> = {
  MEDIA: 'media',
  KYC: 'kyc',
  AGENT_KYC: 'agent-kyc',
  ADVERTISER_KYC: 'advertiser-kyc',
  EMPLOYEE_KYC: 'employee-kyc',
  USER_KYC: 'user-kyc',
  PRINT_PARTNER_KYC: 'print-partner-kyc',
  DISPUTE_EVIDENCE: 'dispute-evidence',
  LISTING_PHOTO: 'listings',
  VERIFICATION: 'verification',
  LISTING_DOCUMENT: 'listing-documents',
  ORDER_EVIDENCE: 'order-evidence',
  AVATAR: 'avatars',
  BRANDING: 'brand',
  CAMPAIGN_CREATIVE: 'creatives',
  TOPUP_PROOF: 'top-up-proofs',
  PAYOUT_EXPORT: 'payout-exports',
  BANK_STATEMENT: 'bank-statements',
  INVOICE: 'invoices',
  STATEMENT: 'statements',
  REPORT: 'reports',
  DATA_EXPORT: 'data-exports',
  BOOKING_REPORT: 'booking-reports',
  PARTNER_RATE_CARD: 'partner-rate-cards',
  PARTNER_INVOICE: 'partner-invoices',
  SUPPORT_ATTACHMENT: 'support-attachments',
  SIGNED_AGREEMENT: 'signed-agreements',
  LEAD_CAPTURE: 'lead-captures',
  CALL_RECORDING: 'call-recordings',
  VISIT_PROOF: 'visit-proofs',
  COMPETITOR_CAPTURE: 'competitor-captures',
  FORM_UPLOAD: 'form-uploads',
  OTHER: 'misc',
};

export const ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/svg+xml',
  'application/pdf',
  // Motion creatives for digital screens. H.264 in an MP4 container is what the
  // campaign spec asks for; QuickTime is what an iPhone hands over.
  'video/mp4',
  'video/quicktime',
];

/**
 * The cap for everything but video.
 *
 * A 15-second 1080p H.264 file is comfortably past ten megabytes, and the
 * creative spec allows fifty, so video is checked against its own ceiling rather
 * than dragging the limit up for KYC selfies too.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export const isVideo = (mimetype: string): boolean => mimetype.startsWith('video/');

/**
 * 26 Sep 2026: types admitted for one purpose only. A browser's webcam
 * (MediaRecorder) records WebM, not MP4, so the website's liveness video —
 * purpose USER_KYC — arrives as `video/webm`. Nothing else takes WebM: a
 * digital-screen creative is still MP4/QuickTime by the campaign spec.
 * Checked after the whole form is read, when the purpose is known (a
 * multipart field may arrive after the file).
 */
export const PURPOSE_ONLY_MIME: Readonly<Record<string, readonly string[]>> = {
  'video/webm': ['USER_KYC'],
};

/** Whether the general upload door takes this type for this purpose. */
export function mimeAllowedFor(mimetype: string, purpose: string | undefined): boolean {
  if (ALLOWED_MIME.includes(mimetype)) return true;
  const purposes = PURPOSE_ONLY_MIME[mimetype];
  return Boolean(purposes && purpose && purposes.includes(purpose));
}

/**
 * Lot B (Q85): what a bank's statement export arrives as. Browsers label a
 * .csv three different ways, and Excel-saved files come as its own type.
 */
export const CSV_MIME = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream'];
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
/** 26 Sep 2026: an Excel workbook, for the bulk listing upload. */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
