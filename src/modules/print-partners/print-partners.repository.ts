import type {
  Prisma,
  PrintJob,
  PrintJobStatus,
  PrintPartner,
  PrintQuote,
  PrintQuoteRequest,
  PrintQuoteRequestStatus,
  PrintQuoteStatus,
} from '../../shared/database';

/**
 * Print partners, their jobs, and — Lot H — the quote requests and quotes
 * behind a job.
 *
 * A partner row, the PARTNER User behind it (inactive until ops activates it,
 * Lot H), one job per order, and the request/quote pair a job may have been
 * awarded on. The wallet is opened through `wallets`; the money moves
 * through `wallets.move`. Nothing here touches a balance.
 */

export type PartnerRow = PrintPartner;
export type JobRow = PrintJob;
export type QuoteRequestRow = PrintQuoteRequest;
export type QuoteRow = PrintQuote;

/** A job with the partner the agent collects from. */
export type JobWithPartner = PrintJob & {
  printPartner: Pick<
    PrintPartner,
    'id' | 'name' | 'contactName' | 'mobile' | 'address' | 'city' | 'latitude' | 'longitude'
  >;
};

/**
 * Lot H: a quote with the partner who made it, as the award and the console
 * read it. G13-B: the rate-card columns ride along so the ranking and the
 * reach share one `hasRateCard` rule.
 */
export type QuoteWithPartner = PrintQuote & {
  printPartner: Pick<
    PrintPartner,
    'id' | 'displayId' | 'name' | 'city' | 'rateCardUpdatedAt' | 'rateCardFileId' | 'rateCardRows' | 'turnaroundDays' | 'isActive'
  >;
};

/** Lot H: a request with every quote on it. */
export type QuoteRequestWithQuotes = PrintQuoteRequest & { quotes: QuoteWithPartner[] };

export const PRINT_JOB_STATUSES = [
  'REQUESTED', 'ACCEPTED', 'PRINTING', 'READY', 'COLLECTED', 'CANCELLED',
] as const;

export const QUOTE_REQUEST_STATUSES = ['OPEN', 'AWARDED', 'CANCELLED', 'EXPIRED'] as const;
export const QUOTE_STATUSES = ['SUBMITTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'] as const;

export type NewPartner = {
  displayId: string;
  /** Normalised — +91 and ten digits. Unique on User and copied onto the partner. */
  mobile: string;
  name: string;
  legalName?: string | null;
  gstin?: string | null;
  panNumber?: string | null;
  contactName?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  /** Lot X-B: the `City` row `city` denotes, stamped by the service through `pricing.withCityKey`; null for a typed town. */
  cityId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  capabilities?: string[];
  maxWidthFt?: Prisma.Decimal | null;
  turnaroundDays?: number | null;
  notes?: string | null;
};

export type PartnerPatch = Partial<{
  name: string;
  legalName: string | null;
  gstin: string | null;
  panNumber: string | null;
  contactName: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  /** Lot X-B: rides with `city` — the service stamps it, a caller never sends it. */
  cityId: string | null;
  latitude: number | null;
  longitude: number | null;
  capabilities: string[];
  maxWidthFt: Prisma.Decimal | null;
  turnaroundDays: number | null;
  isActive: boolean;
  notes: string | null;
  /* Lot H */
  activatedAt: Date | null;
  activatedById: string | null;
  rateCardFileId: string | null;
  rateCardUpdatedAt: Date | null;
  rateCardRows: Prisma.InputJsonValue | null;
  acceptsQuoteRequests: boolean;
  invoiceUploadFileId: string | null;
}>;

export type PartnerListFilter = {
  q?: string;
  /** A slug, or a name for the console's older links. */
  city?: string;
  /** Lot X-B: the key `city` resolved to — rows match on it, or on the spelling for the rows whose key is null. */
  cityId?: string | null;
  /** Undefined lists both. */
  active?: boolean;
  /** PP-1: only the shops that applied from the app and are not yet activated. */
  applied?: boolean;
  page: number;
  pageSize: number;
};

/** Lot H: the partners a quote request may reach — active, taking requests. */
export type ReachFilter = {
  city?: string | null;
  /** Lot X-L: the key `city` resolved to — partners match on it, or on the spelling for the rows whose key is null. */
  cityId?: string | null;
  /** Ids to consider whatever their city — a hand-picked invite list. */
  partnerIds?: readonly string[];
};

export type NewJob = {
  orderId: string;
  printPartnerId: string;
  quotedCost?: Prisma.Decimal | null;
  specs?: Prisma.InputJsonValue | null;
  notes?: string | null;
  /** Lot H: the quote the job was awarded on. */
  awardedQuoteId?: string | null;
};

export type JobPatch = Partial<{
  printPartnerId: string;
  status: PrintJobStatus;
  quotedCost: Prisma.Decimal | null;
  actualCost: Prisma.Decimal | null;
  specs: Prisma.InputJsonValue | null;
  requestedAt: Date;
  readyAt: Date | null;
  collectedAt: Date | null;
  costApprovedByUserId: string | null;
  costApprovedAt: Date | null;
  ledgerTransactionId: string | null;
  notes: string | null;
  /* Lot H: the partner's own moves. */
  partnerAcceptedAt: Date | null;
  partnerDeclinedAt: Date | null;
  declineReason: string | null;
  awardedQuoteId: string | null;
  handoverConfirmedAt: Date | null;
  handoverQrId: string | null;
}>;

/** Lot H: the partner's own job list — the list contract, filtered on status. */
export type PartnerJobsFilter = {
  status?: readonly PrintJobStatus[];
  page: number;
  pageSize: number;
};

/**
 * Lot H: what the partner sees of the order behind a job — the artwork, the
 * site, the agent who collects. Read here, in one join, because `orders`
 * exports no read this wide and the job page needs all of it at once.
 */
export type OrderForPrint = {
  id: string;
  status: string;
  campaignName: string | null;
  designUrl: string | null;
  startDate: Date | null;
  endDate: Date | null;
  listing: {
    id: string;
    title: string;
    address: string;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
    size: string | null;
  };
  agent: { id: string; userId: string; name: string | null; mobile: string | null } | null;
  /** The approved creative for this spot (spot-specific first, else campaign-wide), if the order came from a campaign. */
  creative: { fileUrl: string | null; fileName: string | null; mimeType: string | null; widthPx: number | null; heightPx: number | null } | null;
};

export type NewQuoteRequest = {
  orderId: string;
  /** The envelope: `{ specs, invitedPartnerIds, inviteMode, reinvitedAt }` — see `print-quotes.service.ts`. */
  specs: Prisma.InputJsonValue;
  city: string | null;
  deadlineAt: Date;
  createdById: string;
};

export type QuoteRequestPatch = Partial<{
  specs: Prisma.InputJsonValue;
  deadlineAt: Date;
  status: PrintQuoteRequestStatus;
  awardedQuoteId: string | null;
  awardNote: string | null;
}>;

export type NewQuote = {
  requestId: string;
  printPartnerId: string;
  amount: Prisma.Decimal;
  turnaroundDays: number;
  note: string | null;
};

export type QuotePatch = Partial<{
  amount: Prisma.Decimal;
  turnaroundDays: number;
  note: string | null;
  status: PrintQuoteStatus;
  submittedAt: Date;
}>;

/** Lot H: a file the partner uploaded under a purpose — the invoices list on the console page. */
export type PartnerFileRow = { id: string; filename: string; mimeType: string; sizeBytes: number; url: string; createdAt: Date };

/** G13-B: the desk's list of requests across orders. */
export type QuoteRequestListFilter = {
  status?: readonly PrintQuoteRequestStatus[];
  /** Contains, case-insensitive, on the order id or the city. */
  q?: string;
  page: number;
  pageSize: number;
};

export interface PrintPartnersRepository {
  /* ── Partners ────────────────────────────────────────────────── */
  /** The user behind a mobile, if any — a partner account is never attached to an existing one. */
  findUserByMobile(mobile: string): Promise<{ id: string } | null>;
  emailTaken(email: string): Promise<boolean>;
  /**
   * The User (role PARTNER, `isActive: false` until ops activates it) and
   * the partner, in one transaction — a partner without its account is a
   * payee nobody can record a payout method for.
   */
  createPartner(data: NewPartner): Promise<PartnerRow>;
  /**
   * PP-1: the shop's own application — the person already has an account
   * (they signed in by OTP to apply), so this grants the PARTNER role on it
   * and writes the row with `appliedAt`; the account stays active so they can
   * watch the review from the app.
   */
  createApplication(data: NewPartner & { userId: string; appliedAt: Date }): Promise<PartnerRow>;
  /** PP-1: the roles the account holds, to refuse a publisher's or an agent's number. */
  findUserRoles(userId: string): Promise<string[]>;
  findPartnerByUserId(userId: string): Promise<PartnerRow | null>;
  findPartner(id: string): Promise<PartnerRow | null>;
  /** Lot H: the partner behind a signed-in user. */
  findPartnerByUser(userId: string): Promise<PartnerRow | null>;
  updatePartner(id: string, patch: PartnerPatch): Promise<PartnerRow>;
  /** Lot H: the sign-in switch on the account behind the partner. */
  setUserActive(userId: string, active: boolean): Promise<void>;
  listPartners(filter: PartnerListFilter): Promise<{ items: PartnerRow[]; total: number; counts: Record<string, number> }>;
  /**
   * Lot H: the active partners that accept quote requests — in the city
   * named (Lot X-L: by its key when it resolved, the spelling for rows keyed
   * to nothing), or every one with coordinates when the caller means to
   * filter by distance, or exactly the ids given.
   */
  findPartnersInReach(filter: ReachFilter): Promise<PartnerRow[]>;
  /** Lot H: the partner's own files under a purpose, newest first. */
  listPartnerFiles(userId: string, purpose: string, limit: number): Promise<PartnerFileRow[]>;
  /** G13-B: files by id — the invoices an admin uploaded on the partner's behalf, named on the audit rows. */
  findFilesByIds(ids: readonly string[]): Promise<PartnerFileRow[]>;
  /** G13-B: when the accounts behind these partners last signed in — `User.lastLoginAt`, by user id. */
  findLastLogins(userIds: readonly string[]): Promise<{ userId: string; lastLoginAt: Date | null }[]>;
  /** O-B: `{ id, label, displayId }` per id in one query — the section overview names its top partners with it. */
  findLabelsByIds(ids: readonly string[]): Promise<{ id: string; label: string; displayId: string | null }[]>;

  /* ── Jobs ────────────────────────────────────────────────────── */
  createJob(data: NewJob): Promise<JobWithPartner>;
  findJobByOrder(orderId: string): Promise<JobWithPartner | null>;
  /** E9: the jobs of a page of orders in one read — for the port's `pickupsFor`. */
  findJobsByOrders(orderIds: readonly string[]): Promise<JobWithPartner[]>;
  findJob(id: string): Promise<JobWithPartner | null>;
  updateJob(id: string, patch: JobPatch): Promise<JobWithPartner>;
  listJobsForPartner(printPartnerId: string, limit: number): Promise<JobRow[]>;
  /** Jobs per status for one partner — the ledger view's header. */
  countJobsForPartner(printPartnerId: string): Promise<{ status: PrintJobStatus; count: number }[]>;
  /** Lot H: the partner's own job list, a page at a time with the chip counts. */
  listPartnerJobs(printPartnerId: string, filter: PartnerJobsFilter): Promise<{ items: JobRow[]; total: number; counts: Record<string, number> }>;
  /** Lot H: the order behind a job, as the partner sees it. */
  findOrderForPrint(orderId: string): Promise<OrderForPrint | null>;
  /** Lot H: the same for a page of jobs, in one read. */
  findOrdersForPrint(orderIds: readonly string[]): Promise<OrderForPrint[]>;

  /* ── Quote requests and quotes (Lot H) ───────────────────────── */
  createQuoteRequest(data: NewQuoteRequest): Promise<QuoteRequestWithQuotes>;
  findQuoteRequest(id: string): Promise<QuoteRequestWithQuotes | null>;
  /** The most recent request on an order, whatever its status. */
  findLatestQuoteRequestForOrder(orderId: string): Promise<QuoteRequestWithQuotes | null>;
  updateQuoteRequest(id: string, patch: QuoteRequestPatch): Promise<QuoteRequestWithQuotes>;
  /** The requests a partner was invited to (`invitedPartnerIds` in the envelope), newest deadline first. */
  listQuoteRequestsForPartner(printPartnerId: string, filter: { status?: readonly PrintQuoteRequestStatus[]; page: number; pageSize: number }): Promise<{ items: QuoteRequestWithQuotes[]; total: number; counts: Record<string, number> }>;
  /** OPEN requests whose deadline has passed — the nightly job's read. */
  findOpenRequestsPastDeadline(now: Date): Promise<QuoteRequestWithQuotes[]>;
  /** G13-B: the desk's list across orders — OPEN first, nearest deadline first — with the chip counts. */
  listQuoteRequests(filter: QuoteRequestListFilter): Promise<{ items: QuoteRequestWithQuotes[]; total: number; counts: Record<string, number> }>;
  createQuote(data: NewQuote): Promise<QuoteWithPartner>;
  findQuote(id: string): Promise<QuoteWithPartner | null>;
  updateQuote(id: string, patch: QuotePatch): Promise<QuoteWithPartner>;
  /** Every quote on the request in `fromStatus` but the ones named, patched — the award's rejections, a reopen's un-rejections. */
  updateQuotesOnRequest(requestId: string, exceptQuoteIds: readonly string[], fromStatus: PrintQuoteStatus, patch: QuotePatch): Promise<number>;
  /** The partner's quote history, newest first — the console's `/:id/quotes`. */
  listQuotesForPartner(printPartnerId: string, limit: number): Promise<(QuoteRow & { request: Pick<PrintQuoteRequest, 'id' | 'orderId' | 'status' | 'deadlineAt' | 'awardedQuoteId'> })[]>;
}
