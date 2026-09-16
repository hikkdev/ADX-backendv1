import type { Advertiser, AdvertiserKyc, KycStatus } from '../../../shared/database';
import type { KycQueueState } from '../../../shared/kyc-state';
import type { AdvertiserKycColumns, NewAdvertiserKycColumns } from './advertiser-kyc.schema';

export type AdvertiserKycFilter = {
  /**
   * N3-B: the party's state (`shared/kyc-state`). `status` stays as the old
   * facet's alias — the controller maps it onto `state`; a repository given
   * both honours `state`.
   */
  state?: KycQueueState;
  status?: KycStatus;
  /** Lot D (Q119): a filter, not ownership — `null` is the unassigned. */
  assignedToId?: string | null;
  /** Lot G (Q127/142): only the escalated (true) or the not (false). */
  escalated?: boolean;
  /** Lot N: only the requested-and-not-yet-submitted (true), or none of them (false) — N3-B: the REQUESTED state, as a switch. */
  requested?: boolean;
  /** N2-B / N3-B: one advertiser — the Advertiser profile id **or** the user id — one row or none. */
  advertiserId?: string;
  /** N3-B: the party's name, company, display id, email or mobile contains. */
  q?: string;
};

/**
 * N3-B: how a record is keyed. `advertiserProfileId` is the Advertiser
 * profile — the key every read resolves first; `advertiserId` is the USER,
 * the legacy key, null for an advertiser ops created on the console who has
 * no app account yet. A write is addressed by `id` when the service already
 * holds a legacy row that has no profile key yet (the write then adopts the
 * profile key), else by the profile when there is one, else by the user (a
 * user with no profile — an account predating the model).
 */
export type AdvertiserKycKey = { id?: string; advertiserProfileId: string | null; advertiserId: string | null };

/** Lot N: what the desk's request stamps. */
export type KycRequestStamp = { requestedById: string; requestedChannel: 'DIGIO' | 'MANUAL'; at: Date };
/** Lot N: what the desk's recording stamps — who, how, the method, and the moment for a first submission. */
export type KycRecordStamp = { recordedById: string; recordedVia: 'DESK'; method: 'MANUAL'; at: Date };

/** Lot D (Q42): what a decision writes beside the status. */
export type ReviewStamp = { reviewedById: string; reviewNote?: string | null };

/** Absent means breaches of the review SLA first. See listAdvertiserKycs. */
export type AdvertiserKycSort = 'oldest' | 'newest';

/** N3-B: what the queue carries of the party behind a row. */
export type AdvertiserPartySlice = Pick<
  Advertiser,
  'id' | 'displayId' | 'name' | 'companyName' | 'email' | 'mobile' | 'city' | 'userId' | 'kycStatus' | 'type' | 'createdAt'
>;

/**
 * N3-B: a queue row is a PARTY — every Advertiser — with its derived `state`,
 * and the record's columns spread over it when it has one (every column null
 * otherwise, `kycId` null). `id` is the record's id when there is one, else
 * the profile's — either is accepted as `:id` on every desk route. `party`
 * is the profile slice; `advertiser` is the same object under the name the
 * queue always had.
 */
export type AdvertiserKycQueueRow = { [K in keyof AdvertiserKyc]: AdvertiserKyc[K] | null } & {
  id: string;
  kycId: string | null;
  state: KycQueueState;
  party: AdvertiserPartySlice;
  advertiser: AdvertiserPartySlice;
};

export interface AdvertiserKycRepository {
  /** N3-B: a page of parties, left-joined to their record, in one of six states. */
  findPage(
    where: AdvertiserKycFilter,
    page: number,
    pageSize: number,
    sort?: AdvertiserKycSort,
  ): Promise<{ items: AdvertiserKycQueueRow[]; total: number }>;
  /**
   * Pending submissions older than `cutoff` — the SLA breaches, counted
   * across the whole queue rather than the page in hand, because the header
   * says how many are late in total. Submitted rows only.
   */
  countBreached(where: AdvertiserKycFilter, cutoff: Date): Promise<number>;
  /** N3-B: the chips — parties per state over the filter (the caller strips the state facet). */
  countByState(where: AdvertiserKycFilter): Promise<Record<KycQueueState, number>>;
  /** Lot G (Q127/142): escalated cases across the whole queue (the caller strips the escalated facet). */
  countEscalated(where: AdvertiserKycFilter): Promise<number>;
  /** Lot N: requested-and-not-submitted rows across the whole queue (the caller strips the requested facet). */
  countRequested(where: AdvertiserKycFilter): Promise<number>;
  /** Lot N: the desk asked for this KYC — an upsert on the key; the status is untouched. */
  requestKyc(key: AdvertiserKycKey, stamp: KycRequestStamp): Promise<AdvertiserKyc>;
  /** The legacy key: the advertiser's USER id. */
  findByAdvertiserId(advertiserId: string): Promise<AdvertiserKyc | null>;
  /** N3-B: the record by the Advertiser profile it belongs to. */
  findByProfileId(advertiserProfileId: string): Promise<AdvertiserKyc | null>;
  /** N3-B: by the key — the profile when it has one, else the user. */
  findByKey(key: AdvertiserKycKey): Promise<AdvertiserKyc | null>;
  findById(id: string): Promise<AdvertiserKyc | null>;
  create(key: AdvertiserKycKey, data: NewAdvertiserKycColumns): Promise<AdvertiserKyc>;
  /**
   * Submission or resubmission by the owner: the columns sent are written,
   * the rest kept, the record goes (back) to PENDING. Lot F: an upsert —
   * the phone's ladder PUTs the first submission too.
   */
  resubmit(key: AdvertiserKycKey, data: AdvertiserKycColumns): Promise<AdvertiserKyc>;
  /** Lot F: pins the manifest version once — a no-op when the row already has one. */
  pinManifestVersion(key: AdvertiserKycKey, version: number): Promise<unknown>;
  /** Admin edit by id: does not touch status. Lot N: stamps who recorded it and how; `submittedAt` is set where it was null. */
  updateById(id: string, data: AdvertiserKycColumns, stamp?: KycRecordStamp): Promise<AdvertiserKyc>;
  /**
   * N2-B: the desk's first recording for an advertiser with no row yet —
   * the row made PENDING with `submittedAt` the stamp's moment, the
   * recorder and the method stamped, `kycType` as the service resolved it.
   * N3-B: keyed by the profile; `advertiserId` null when the profile has no user.
   */
  createAtDesk(key: AdvertiserKycKey, data: NewAdvertiserKycColumns, stamp: KycRecordStamp): Promise<AdvertiserKyc>;
  review(id: string, status: KycStatus, rejectionReason: string | null, stamp?: ReviewStamp): Promise<AdvertiserKyc>;
  /** Lot D (Q42): NEEDS_INFO — the party is asked for the flagged documents again. */
  requestReupload(id: string, stamp: ReviewStamp): Promise<AdvertiserKyc>;
  /** Lot D (Q119): who is working the case, or nobody. */
  assign(ids: string[], adminUserId: string | null, at: Date): Promise<number>;
  /** Lot D (Q127): Digio-verified rows still holding images, verified before `cutoff`. */
  findPurgeable(cutoff: Date, limit: number): Promise<AdvertiserKyc[]>;
  /** Nulls the image columns, masks the PAN, trims the payload, stamps `imagesPurgedAt`. */
  purgeImages(id: string, data: { panNumber: string | null; digioPayload: unknown }): Promise<AdvertiserKyc>;
  remove(id: string): Promise<unknown>;

  // U7, demand side: the Digio request on the advertiser's own row.
  upsertDigio(key: AdvertiserKycKey, fields: AdvertiserDigioFields): Promise<AdvertiserKyc>;
  findByDigioRequestId(kycId: string): Promise<AdvertiserKyc | null>;
  applyDigioWebhook(id: string, update: AdvertiserDigioUpdate): Promise<AdvertiserKyc>;
}

export type AdvertiserDigioFields = {
  method: 'DIGIO';
  digioRequestId: string;
  digioReferenceId: string;
  digioStatus: string;
  submittedAt: Date;
};

/**
 * What Digio's answer writes. The repository stamps `recordedVia` DIGIO with
 * no recorder, and — N2-B — `method` DIGIO when the status is VERIFIED, so a
 * record whose documents were sent by hand while the session was open is
 * Digio-verified once Digio says so (the liveness gate exempts DIGIO; the
 * purge finds it).
 */
export type AdvertiserDigioUpdate = {
  digioStatus: string;
  digioPayload: unknown;
  digioVerifiedAt?: Date | undefined;
  status: KycStatus;
  reviewedAt?: Date | undefined;
  rejectionReason?: string | undefined;
};
