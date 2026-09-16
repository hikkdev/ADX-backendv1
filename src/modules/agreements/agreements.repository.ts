import type {
  AgreementAcceptance,
  AgreementKind,
  AgreementTemplate,
  KycStatus,
} from '../../shared/database';
import type { Page, PageQuery } from '../../shared/pagination';

/**
 * The three parties that sign anything. Publishers and advertisers hold
 * platform terms; an agent (Lot D, Q123) signs only JOB_TERMS, per offer.
 */
export type PartyType = 'publisher' | 'advertiser' | 'agent';

/** A template row with the count the console shows beside every version. */
export type TemplateRow = AgreementTemplate & { acceptanceCount: number };

export type NewTemplate = {
  kind: AgreementKind;
  version: number;
  title: string;
  body: string;
  changeNote?: string | null;
  createdByUserId?: string | null;
  requiresReacceptance?: boolean;
};

export type TemplatePatch = {
  title?: string;
  body?: string;
  changeNote?: string | null;
  requiresReacceptance?: boolean;
};

/** Exactly one of the three is set — the schema's CHECK constraint says so. */
export type AcceptanceParty = {
  publisherId?: string | null | undefined;
  advertiserId?: string | null | undefined;
  agentId?: string | null | undefined;
};

/** The transaction an acceptance is anchored on, when it is not the platform terms. */
export type AcceptanceAnchor = {
  attemptId?: string | null | undefined;
  campaignId?: string | null | undefined;
  packageSaleId?: string | null | undefined;
  orderId?: string | null | undefined;
};

export type NewAcceptance = AcceptanceParty &
  AcceptanceAnchor & {
    templateId: string;
    templateKind: AgreementKind;
    templateVersion: number;
    acceptedByUserId: string;
    ipAddress?: string | null | undefined;
    userAgent?: string | null | undefined;
    renderedDocument?: string | null | undefined;
  };

/**
 * Lot D (Q123): what an insertion order enumerates — the campaign as it
 * stands when the advertiser clicks. Read here, narrowly, because this module
 * sits under `campaigns` and cannot import it.
 */
export type InsertionOrderSnapshot = {
  id: string;
  reference: string;
  name: string;
  advertiserId: string;
  advertiserName: string;
  startDate: Date | null;
  endDate: Date | null;
  spots: {
    id: string;
    title: string;
    city: string | null;
    ratePerDay: string;
    days: number;
    quantity: number;
    lineTotal: string;
  }[];
};

/** A party behind the live platform terms — `GET /agreements/stale`. */
export type StaleParty = {
  type: PartyType;
  id: string;
  displayId: string | null;
  name: string;
  acceptedVersion: number;
};

/** An acceptance the way ops reads it: who clicked, for whom, on which text. */
export type AcceptanceRow = AgreementAcceptance & {
  template: { title: string };
  acceptedBy: { id: string; name: string | null; mobile: string };
  publisher: { id: string; displayId: string | null; name: string } | null;
  advertiser: { id: string; displayId: string | null; name: string } | null;
};

export type AcceptanceFilter = {
  publisherId?: string | undefined;
  advertiserId?: string | undefined;
  agentId?: string | undefined;
  templateId?: string | undefined;
  kind?: AgreementKind | undefined;
  /** E7-3: the transaction anchors. */
  campaignId?: string | undefined;
  orderId?: string | undefined;
  packageSaleId?: string | undefined;
  attemptId?: string | undefined;
};

/** A party as the lookup finds it: enough to pick it out of a list. */
export type PartySummary = {
  type: PartyType;
  id: string;
  displayId: string | null;
  name: string;
  mobile: string;
  city: string | null;
  kycStatus: KycStatus;
  activatedAt: Date | null;
  createdAt: Date;
};

export interface AgreementsRepository {
  /* Templates */
  listTemplates(kind?: AgreementKind): Promise<TemplateRow[]>;
  findTemplate(id: string): Promise<TemplateRow | null>;
  activeTemplate(kind: AgreementKind): Promise<TemplateRow | null>;
  highestVersion(kind: AgreementKind): Promise<number>;
  createTemplate(data: NewTemplate): Promise<TemplateRow>;
  updateTemplate(id: string, patch: TemplatePatch): Promise<TemplateRow>;
  deleteTemplate(id: string): Promise<void>;
  /**
   * Retires every live version of the kind and makes this one live, as one
   * transaction: there is never a moment with two live versions or none.
   */
  activateTemplate(
    id: string,
    kind: AgreementKind,
    at: Date,
    /** E7-3: the re-acceptance switch, written in the same transaction as the activation. */
    patch?: { requiresReacceptance?: boolean | undefined },
  ): Promise<TemplateRow>;

  /* Acceptances */
  listAcceptances(filter: AcceptanceFilter, page?: PageQuery): Promise<Page<AcceptanceRow>>;
  /** The same filter, counted — Lot A's closure review reports a number, not a page. */
  countAcceptances(filter: AcceptanceFilter): Promise<number>;
  /**
   * Lot D (Q123): the newest platform-scope acceptance of a kind by a party —
   * the one with no transaction anchor. Null when they never clicked.
   */
  findPlatformAcceptance(kind: AgreementKind, party: AcceptanceParty): Promise<AgreementAcceptance | null>;
  /** The newest acceptance anchored on one transaction — any version. */
  findAnchoredAcceptance(kind: AgreementKind, anchor: AcceptanceAnchor): Promise<AgreementAcceptance | null>;
  createAcceptance(data: NewAcceptance): Promise<AgreementAcceptance>;
  /** Parties whose highest accepted version of a platform kind is below `currentVersion`. */
  partiesBehind(kind: AgreementKind, currentVersion: number): Promise<StaleParty[]>;

  /* Campaigns — read-only, for the insertion order's enumeration. */
  campaignForInsertionOrder(campaignId: string): Promise<InsertionOrderSnapshot | null>;

  /* Parties — read-only; the rows belong to publishers and advertisers. */
  searchParties(query: string, limitPerType: number): Promise<PartySummary[]>;
  findParty(type: PartyType, id: string): Promise<PartySummary | null>;
}
