import { ApiError } from '../../shared/errors';
import type { AgreementKind } from '../../shared/database';
import { MAX_PAGE_SIZE, type PageQuery } from '../../shared/pagination';
import { prismaAgreementsRepository as repository } from './prisma-agreements.repository';
import type { AgreementAcceptance } from '../../shared/database';
import type {
  AcceptanceAnchor,
  AcceptanceFilter,
  AcceptanceParty,
  AcceptanceRow,
  InsertionOrderSnapshot,
  PartySummary,
  PartyType,
  StaleParty,
  TemplateRow,
} from './agreements.repository';

/* ------------------------------------------------------------------ */
/* Kinds                                                               */
/* ------------------------------------------------------------------ */

/**
 * Which party a kind binds, and whether it is the platform terms that gate
 * activation or a per-transaction agreement that gates one deal.
 */
/**
 * DS-1: who a kind binds — the three acceptance parties, and the two that
 * only ever e-sign (an employee, a print partner) and so have no acceptance
 * row: their SigningRequest is the record.
 */
export type AgreementParty = PartyType | 'employee' | 'print-partner';

export const KIND_META: Record<
  AgreementKind,
  { party: AgreementParty; scope: 'PLATFORM' | 'TRANSACTION'; label: string }
> = {
  PLATFORM: { party: 'publisher', scope: 'PLATFORM', label: 'Publisher platform terms' },
  LISTING: { party: 'publisher', scope: 'TRANSACTION', label: 'Listing agreement' },
  ADVERTISER_PLATFORM: {
    party: 'advertiser',
    scope: 'PLATFORM',
    label: 'Advertiser platform terms',
  },
  INSERTION_ORDER: { party: 'advertiser', scope: 'TRANSACTION', label: 'Insertion order' },
  /// Lot D (Q123): one acceptance per package sale, at payment.
  PACKAGE_SALE: { party: 'advertiser', scope: 'TRANSACTION', label: 'Package order terms' },
  /// Lot D (Q123): the agent's job terms, accepted on the agent's own tap.
  JOB_TERMS: { party: 'agent', scope: 'TRANSACTION', label: 'Agent job terms' },
  /// AG-1: the engagement terms an applicant accepts before review, one text per side.
  AGENT_PUBLISHER_PLATFORM: { party: 'agent', scope: 'PLATFORM', label: 'Field agent engagement terms' },
  AGENT_ADVERTISER_PLATFORM: { party: 'agent', scope: 'PLATFORM', label: 'Sales agent engagement terms' },
  /// DS-2: the employee's appointment letter and NDA — e-signed through a hosted link; gates the console invitation.
  EMPLOYEE_APPOINTMENT: { party: 'employee', scope: 'PLATFORM', label: 'Employee appointment and NDA' },
  /// DS-2: the print partner's service agreement — e-signed once KYC verifies; gates quotes and jobs.
  PRINT_PARTNER_SERVICE: { party: 'print-partner', scope: 'PLATFORM', label: 'Print partner service agreement' },
  /// DS-3: the publisher's master licence to display — one signed document per publisher, listings as its schedule.
  PUBLISHER_LICENCE: { party: 'publisher', scope: 'PLATFORM', label: 'Publisher licence to display' },
};

/** The platform terms each party type is stuck behind until a version is live. */
export const PLATFORM_KIND_FOR: Partial<Record<PartyType, AgreementKind>> = {
  publisher: 'PLATFORM',
  advertiser: 'ADVERTISER_PLATFORM',
  // An agent has no platform terms of their own: JOB_TERMS is accepted per offer (Lot D).
};

/**
 * Lot D (Q123): the transaction each per-deal kind is anchored on. One
 * acceptance per anchor per template version — the partial indexes in the
 * migration enforce it, and `recordAcceptance` reads before it writes so a
 * retry returns the row rather than tripping the index.
 */
export const ANCHOR_FOR: Partial<Record<AgreementKind, keyof AcceptanceAnchor>> = {
  LISTING: 'attemptId',
  INSERTION_ORDER: 'campaignId',
  PACKAGE_SALE: 'packageSaleId',
  JOB_TERMS: 'orderId',
};

const PARTY_FIELD: Record<PartyType, keyof AcceptanceParty> = {
  publisher: 'publisherId',
  advertiser: 'advertiserId',
  agent: 'agentId',
};

/* ------------------------------------------------------------------ */
/* Template state                                                      */
/* ------------------------------------------------------------------ */

export type TemplateState = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';

/**
 * A version is one of three things, and only a draft may still be edited.
 *
 * A version somebody accepted was live whether or not the row says so: the
 * older publish routes in supply and advertisers set `isActive` without
 * stamping `activatedAt`, and a version they later superseded would otherwise
 * read as a draft and become editable under people who accepted it.
 */
export function templateState(
  template: Pick<TemplateRow, 'isActive' | 'activatedAt' | 'retiredAt' | 'acceptanceCount'>,
): TemplateState {
  if (template.isActive) return 'ACTIVE';
  if (template.activatedAt || template.retiredAt || template.acceptanceCount > 0) {
    return 'SUPERSEDED';
  }
  return 'DRAFT';
}

export type TemplateView = TemplateRow & { state: TemplateState };

const view = (template: TemplateRow): TemplateView => ({
  ...template,
  state: templateState(template),
});

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export async function listTemplates(kind?: AgreementKind): Promise<TemplateView[]> {
  return (await repository.listTemplates(kind)).map(view);
}

export async function getTemplate(id: string): Promise<TemplateView> {
  const template = await repository.findTemplate(id);
  if (!template) throw new ApiError(404, 'NOT_FOUND', 'Agreement template not found');
  return view(template);
}

/**
 * The live text of a kind — what a party is shown before the click. 404 with
 * NO_ACTIVE_TEMPLATE rather than an empty answer, because "nothing is
 * published" is the configuration problem the gate errors already name.
 */
export async function currentTemplate(kind: AgreementKind): Promise<TemplateView> {
  const template = await repository.activeTemplate(kind);
  if (!template) {
    throw new ApiError(
      404,
      'NO_ACTIVE_TEMPLATE',
      `No ${KIND_META[kind].label.toLowerCase()} is published yet`,
    );
  }
  return view(template);
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/**
 * A new version of a kind, numbered after the highest that exists — drafts
 * and retired versions included, so a number is never reused for different
 * text. A draft unless asked otherwise.
 */
export async function createTemplate(input: {
  kind: AgreementKind;
  title: string;
  body: string;
  changeNote?: string | undefined;
  activate?: boolean | undefined;
  /** Lot D (Q55): platform-scope kinds only; ignored on the transaction kinds. */
  requiresReacceptance?: boolean | undefined;
  createdByUserId: string;
}): Promise<TemplateView> {
  const version = (await repository.highestVersion(input.kind)) + 1;
  let created: TemplateRow;
  try {
    created = await repository.createTemplate({
      kind: input.kind,
      version,
      title: input.title,
      body: input.body,
      changeNote: input.changeNote ?? null,
      createdByUserId: input.createdByUserId,
      requiresReacceptance:
        KIND_META[input.kind].scope === 'PLATFORM' && Boolean(input.requiresReacceptance),
    });
  } catch (error) {
    // Two people saving a new version at the same moment race for the same
    // number. The second loses cleanly rather than as a 500.
    if (isUniqueViolation(error)) {
      throw new ApiError(
        409,
        'CONFLICT',
        `Version ${version} was created by somebody else a moment ago. Reload and try again.`,
      );
    }
    throw error;
  }
  return input.activate ? activateTemplate(created.id) : view(created);
}

/* ------------------------------------------------------------------ */
/* E6: the placeholder drafts                                          */
/* ------------------------------------------------------------------ */

export const PLACEHOLDER_MARKER = '[PLACEHOLDER - ADX legal text to be supplied before publishing]';

/**
 * Which kinds get a draft at boot, and the variables each body renders —
 * so the draft ops open at /agreements/templates already shows where the
 * schedule lands. LISTING is left out: its template is published from the
 * supply desk with the listing enumeration and has its own seed there.
 */
export const SEEDED_KINDS: readonly AgreementKind[] = [
  'PLATFORM',
  'ADVERTISER_PLATFORM',
  'INSERTION_ORDER',
  'PACKAGE_SALE',
  'JOB_TERMS',
  'AGENT_PUBLISHER_PLATFORM',
  'AGENT_ADVERTISER_PLATFORM',
  // DS-1: the three signed-only kinds, so the Signatures desk has a template to publish.
  'EMPLOYEE_APPOINTMENT',
  'PRINT_PARTNER_SERVICE',
  'PUBLISHER_LICENCE',
];

const PLACEHOLDER_VARIABLES: Partial<Record<AgreementKind, { token: string; what: string }>> = {
  INSERTION_ORDER: { token: '{{spots}}', what: 'the campaign, its flight and the table of sites booked' },
  PACKAGE_SALE: { token: '{{sale}}', what: 'the package, its add-ons and the price' },
  PUBLISHER_LICENCE: { token: '{{listings}}', what: "Schedule A — the publisher's listings on the platform when the licence is signed" },
};

/**
 * DS-1: the merge fields an e-signed document may name. Every signed kind
 * takes the party block and the date; the rest depend on who signs.
 */
const SIGNING_FIELD_HINTS: Partial<Record<AgreementKind, string[]>> = {
  AGENT_PUBLISHER_PLATFORM: ['{{agent.side}}', '{{agent.grade}}', '{{agent.engagement}}', '{{agent.startDate}}'],
  AGENT_ADVERTISER_PLATFORM: ['{{agent.side}}', '{{agent.grade}}', '{{agent.engagement}}', '{{agent.startDate}}'],
  EMPLOYEE_APPOINTMENT: ['{{employee.designation}}', '{{employee.department}}', '{{employee.employmentType}}'],
  PRINT_PARTNER_SERVICE: ['{{party.tradeName}}', '{{party.gstin}}', '{{party.pan}}'],
  PUBLISHER_LICENCE: ['{{party.type}}', '{{party.gstin}}', '{{party.band}}'],
  INSERTION_ORDER: ['{{party.company}}', '{{party.gstin}}', '{{party.band}}'],
};

/**
 * LT-1: the location-sharing clause the two agent engagement drafts carry,
 * so the consent the app prints under Account is also in the terms the
 * agent signs. A lawyer's wording replaces it with the rest of the text.
 */
const TRACKING_CONSENT_CLAUSE = [
  '## Location sharing',
  '',
  'While the ADX Agent app is open and you are on a job, it shares your position with ADX every minute or so — so the desk can see where you are, tell the customer when you will arrive, and help if something goes wrong. Nothing is shared when the app is closed or you are not on a job. Positions are kept for the period set by ADX (30 days by default) and then deleted.',
];

export function placeholderDraft(kind: AgreementKind): { title: string; body: string; changeNote: string } {
  const variable = PLACEHOLDER_VARIABLES[kind];
  const body = [
    `# ${KIND_META[kind].label}`,
    '',
    PLACEHOLDER_MARKER,
    '',
    'This draft was created by the platform so the template exists to edit. It is not live: every gate that needs',
    `${KIND_META[kind].label.toLowerCase()} keeps answering 503 NO_ACTIVE_TEMPLATE until a version is published here.`,
    ...(variable
      ? ['', `The platform renders ${variable.what} where \`${variable.token}\` appears; without the token it is appended at the end.`, '', variable.token]
      : []),
    ...(SIGNING_FIELD_HINTS[kind]
      ? [
          '',
          'When this document is e-signed (Settings › Platform › E-signing), these fields are filled in from the record before the PDF is rendered:',
          '`{{party.name}}`, `{{party.displayId}}`, `{{party.signer}}`, `{{party.email}}`, `{{party.mobile}}`, `{{party.city}}`, `{{party.state}}`, `{{date}}`, `{{reference}}`,',
          `${SIGNING_FIELD_HINTS[kind]!.map((field) => '`' + field + '`').join(', ')}.`,
        ]
      : []),
    ...(KIND_META[kind].party === 'agent' && KIND_META[kind].scope === 'PLATFORM' ? ['', ...TRACKING_CONSENT_CLAUSE] : []),
  ].join('\n');
  return { title: `${KIND_META[kind].label} (draft)`, body, changeNote: 'Placeholder draft seeded at boot (E6)' };
}

/**
 * E6: a fresh database has no template of any kind, so every gate answers
 * 503 NO_ACTIVE_TEMPLATE and nothing tells ops where to type the words.
 * This seeds version 1 of each missing kind as a DRAFT whose body is a
 * clearly marked placeholder. A DRAFT never satisfies a gate, so behaviour is
 * unchanged until ops edit and publish it at /agreements/templates; a kind
 * that already has any row — draft, live or superseded — is never touched.
 * Idempotent; returns the kinds it created. Called at boot beside
 * `ensureSystemRoles`.
 */
export async function ensureAgreementDrafts(): Promise<AgreementKind[]> {
  const created: AgreementKind[] = [];
  for (const kind of SEEDED_KINDS) {
    if ((await repository.highestVersion(kind)) > 0) continue;
    const draft = placeholderDraft(kind);
    try {
      await repository.createTemplate({ kind, version: 1, ...draft, createdByUserId: null });
      created.push(kind);
    } catch (error) {
      // Two instances booting together: the second finds the first's row.
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return created;
}

/**
 * Only a draft's text may change. A version that has been live is what people
 * accepted, and an acceptance points at the row, not a copy of it.
 */
export async function updateTemplate(
  id: string,
  patch: {
    title?: string | undefined;
    body?: string | undefined;
    changeNote?: string | null | undefined;
    requiresReacceptance?: boolean | undefined;
  },
): Promise<TemplateView> {
  const template = await getTemplate(id);
  if (template.state !== 'DRAFT') {
    throw new ApiError(
      409,
      'CONFLICT',
      `Version ${template.version} has been live and its text is what people accepted. Create a new version instead.`,
    );
  }
  const clean = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
    ...(patch.changeNote !== undefined ? { changeNote: patch.changeNote } : {}),
    ...(patch.requiresReacceptance !== undefined && KIND_META[template.kind].scope === 'PLATFORM'
      ? { requiresReacceptance: patch.requiresReacceptance }
      : {}),
  };
  return view(await repository.updateTemplate(id, clean));
}

export async function deleteTemplate(id: string): Promise<void> {
  const template = await getTemplate(id);
  if (template.state !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', 'Only a draft can be discarded');
  }
  await repository.deleteTemplate(id);
}

/**
 * Makes a version the one every new acceptance of its kind points at, and
 * retires whichever was live. Idempotent on the live version. Works on a
 * retired version too — that is the rollback when a new version turns out
 * wrong — and existing acceptances are untouched either way: nobody is asked
 * to accept again. See the README on re-acceptance.
 */
export async function activateTemplate(
  id: string,
  options: { requiresReacceptance?: boolean | undefined } = {},
): Promise<TemplateView> {
  const template = await getTemplate(id);
  // E7-3: the re-acceptance switch rides on the activation — platform kinds
  // only, because a transaction kind never asks anyone twice (Lot D, Q55).
  if (options.requiresReacceptance !== undefined && KIND_META[template.kind].scope !== 'PLATFORM') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'requiresReacceptance applies to the platform kinds only');
  }
  if (template.state === 'ACTIVE') {
    if (options.requiresReacceptance === undefined || options.requiresReacceptance === template.requiresReacceptance) {
      return template;
    }
    // Already live: only the switch moves; the activation stamps stay.
    return view(await repository.updateTemplate(id, { requiresReacceptance: options.requiresReacceptance }));
  }
  return view(
    await repository.activateTemplate(
      id,
      template.kind,
      new Date(),
      options.requiresReacceptance !== undefined ? { requiresReacceptance: options.requiresReacceptance } : {},
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Acceptances and parties                                             */
/* ------------------------------------------------------------------ */

export function listAcceptances(filter: AcceptanceFilter, page: PageQuery = {}) {
  return repository.listAcceptances(filter, page);
}

/**
 * How many agreements this party has standing — Lot A's closure review (Q21).
 *
 * An acceptance is never withdrawn: the text was agreed and the record of that
 * survives the account. So this is reported on the review and never blocks a
 * closure; it is there so the desk knows what it is closing over.
 */
export function countAcceptancesFor(filter: {
  publisherId?: string | undefined;
  advertiserId?: string | undefined;
}): Promise<number> {
  if (!filter.publisherId && !filter.advertiserId) return Promise.resolve(0);
  return repository.countAcceptances(filter);
}

/* ------------------------------------------------------------------ */
/* Lot D (Q123): recording the click, and asking whether it stands     */
/* ------------------------------------------------------------------ */

export type AcceptanceContext = {
  acceptedByUserId: string;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
};

/**
 * Whether an acceptance satisfies the live template.
 *
 * Any acceptance does, unless the live version says `requiresReacceptance` —
 * then only the live version or later counts. Pure, and exported so
 * `advertisers`' booking gate and `supply`'s listing gate apply the one rule
 * rather than each restating it. No live template at all means nothing can
 * be demanded beyond having clicked once.
 */
export function isCurrentAcceptance(
  acceptance: { templateVersion: number } | null | undefined,
  template: { version: number; requiresReacceptance: boolean } | null | undefined,
): boolean {
  if (!acceptance) return false;
  if (!template || !template.requiresReacceptance) return true;
  return acceptance.templateVersion >= template.version;
}

function partyFor(kind: AgreementKind, party: AcceptanceParty): AcceptanceParty {
  const partyType = KIND_META[kind].party;
  if (!(partyType in PARTY_FIELD)) {
    // DS-1: an employee or a print partner has no acceptance row; their signature is the record.
    throw new ApiError(400, 'VALIDATION_ERROR', `${KIND_META[kind].label} is signed, not clicked`);
  }
  const field = PARTY_FIELD[partyType as PartyType];
  const id = party[field];
  const others = (Object.keys(PARTY_FIELD) as PartyType[])
    .map((type) => PARTY_FIELD[type])
    .filter((column) => column !== field && party[column]);
  if (!id || others.length > 0) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `${KIND_META[kind].label} binds a ${KIND_META[kind].party}; give exactly that party's id`,
    );
  }
  return { [field]: id };
}

function anchorFor(kind: AgreementKind, anchor: AcceptanceAnchor | undefined): AcceptanceAnchor {
  const field = ANCHOR_FOR[kind];
  if (!field) return {};
  const id = anchor?.[field];
  if (!id) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${KIND_META[kind].label} is accepted per ${field.replace(/Id$/, '')}`);
  }
  return { [field]: id };
}

/**
 * Records that a party accepted the live version of a kind.
 *
 * Idempotent on the version: a platform kind is accepted once per party per
 * version, a transaction kind once per anchor per version, and a second click
 * on the same version returns the first row. A new version live since the
 * last click is a new row — that is how the stale report and the
 * re-acceptance gate see who is behind. 503 NO_ACTIVE_TEMPLATE when nothing
 * is published, which is ops' problem and named as such.
 *
 * `acceptedByUserId` is who clicked. For JOB_TERMS that is the agent's own
 * user — the caller resolves it from the profile, never from a body.
 */
export async function recordAcceptance(input: {
  kind: AgreementKind;
  party: AcceptanceParty;
  anchor?: AcceptanceAnchor | undefined;
  ctx: AcceptanceContext;
  /** The document exactly as accepted, where the kind enumerates something. */
  renderedDocument?: string | null | undefined;
}): Promise<AgreementAcceptance> {
  const party = partyFor(input.kind, input.party);
  const anchor = anchorFor(input.kind, input.anchor);
  const template = await repository.activeTemplate(input.kind);
  if (!template) {
    throw new ApiError(
      503,
      'NO_ACTIVE_TEMPLATE',
      `No ${KIND_META[input.kind].label.toLowerCase()} is published yet`,
    );
  }

  const existing =
    ANCHOR_FOR[input.kind]
      ? await repository.findAnchoredAcceptance(input.kind, anchor)
      : await repository.findPlatformAcceptance(input.kind, party);
  if (existing && existing.templateId === template.id) return existing;

  return repository.createAcceptance({
    ...party,
    ...anchor,
    templateId: template.id,
    templateKind: input.kind,
    templateVersion: template.version,
    acceptedByUserId: input.ctx.acceptedByUserId,
    ipAddress: input.ctx.ipAddress ?? null,
    userAgent: input.ctx.userAgent ?? null,
    renderedDocument: input.renderedDocument ?? null,
  });
}

/** Where a transaction stands against the version live now. The review screens carry this. */
export type AgreementStanding = {
  kind: AgreementKind;
  accepted: boolean;
  /** The version accepted, or null. */
  templateVersion: number | null;
  /** The version live now, or null when nothing is published. */
  currentVersion: number | null;
  /** Accepted on the version live now. What every transaction gate asks. */
  current: boolean;
};

/**
 * A transaction is bound by the version live at the moment it is authorised,
 * so `current` is the only answer that clears a gate: an acceptance of an
 * older version was of different words.
 */
export async function transactionAcceptance(
  kind: AgreementKind,
  anchor: AcceptanceAnchor,
): Promise<AgreementStanding> {
  const [acceptance, template] = await Promise.all([
    repository.findAnchoredAcceptance(kind, anchorFor(kind, anchor)),
    repository.activeTemplate(kind),
  ]);
  return {
    kind,
    accepted: Boolean(acceptance),
    templateVersion: acceptance?.templateVersion ?? null,
    currentVersion: template?.version ?? null,
    current: Boolean(acceptance && template && acceptance.templateId === template.id),
  };
}

/** Where a party stands on the platform terms — the gate they can stall at. */
export type PlatformStanding = {
  kind: AgreementKind;
  currentVersion: number | null;
  requiresReacceptance: boolean;
  accepted: AgreementAcceptance | null;
  /** They may transact: accepted, and current where the live version demands it. */
  satisfied: boolean;
  /** Behind the live version, whether or not that is enforced. */
  outdated: boolean;
};

export async function platformStanding(kind: AgreementKind, party: AcceptanceParty): Promise<PlatformStanding> {
  const [accepted, template] = await Promise.all([
    repository.findPlatformAcceptance(kind, partyFor(kind, party)),
    repository.activeTemplate(kind),
  ]);
  return {
    kind,
    currentVersion: template?.version ?? null,
    requiresReacceptance: template?.requiresReacceptance ?? false,
    accepted,
    satisfied: isCurrentAcceptance(accepted, template),
    outdated: Boolean(accepted && template && accepted.templateVersion < template.version),
  };
}

/** `GET /agreements/stale?kind=` — who holds older platform terms than the live version. */
export async function staleParties(kind: AgreementKind): Promise<{
  kind: AgreementKind;
  currentVersion: number | null;
  /** True when the live version demands re-acceptance: these parties are blocked, not merely behind. */
  enforced: boolean;
  parties: StaleParty[];
}> {
  if (KIND_META[kind].scope !== 'PLATFORM') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only the platform terms can be stale; a transaction accepts the version live at the time');
  }
  const template = await repository.activeTemplate(kind);
  if (!template) return { kind, currentVersion: null, enforced: false, parties: [] };
  return {
    kind,
    currentVersion: template.version,
    enforced: template.requiresReacceptance,
    parties: await repository.partiesBehind(kind, template.version),
  };
}

/* ------------------------------------------------------------------ */
/* Lot D (Q123): the insertion order                                   */
/* ------------------------------------------------------------------ */

const day = (date: Date | null): string => (date ? date.toISOString().slice(0, 10) : '—');

/**
 * Renders the insertion order for a campaign: the live template's body with
 * the campaign's sites enumerated. `{{spots}}` in the body is replaced;
 * without it the schedule is appended. Pure, so the words a party accepted
 * can be reproduced in a test from the same inputs.
 */
export function renderInsertionOrder(body: string, campaign: InsertionOrderSnapshot): string {
  const lines = campaign.spots.map(
    (spot, index) =>
      `${index + 1}. ${spot.title}${spot.city ? `, ${spot.city}` : ''} — ₹${spot.ratePerDay}/day × ${spot.days} day${spot.days === 1 ? '' : 's'} × ${spot.quantity} = ₹${spot.lineTotal}`,
  );
  const schedule = [
    `Campaign ${campaign.reference} — ${campaign.name}`,
    `Advertiser: ${campaign.advertiserName}`,
    `Flight: ${day(campaign.startDate)} to ${day(campaign.endDate)}`,
    '',
    ...lines,
  ].join('\n');
  return body.includes('{{spots}}')
    ? body.replace('{{spots}}', schedule)
    : `${body}\n\n## Sites covered by this insertion order\n\n${schedule}`;
}

/**
 * The advertiser accepts the insertion order for one campaign.
 *
 * The document is rendered here, from the live INSERTION_ORDER template and
 * the campaign's spots as they stand — never from text the client sent, so
 * what is recorded is what ADX showed. The campaign has to be the
 * advertiser's; an agent under a grant accepts *for* them and the row still
 * names the advertiser. One acceptance per campaign per version.
 */
export async function acceptInsertionOrder(
  campaignId: string,
  advertiserId: string,
  ctx: AcceptanceContext,
): Promise<{ accepted: true; templateVersion: number; acceptanceId: string }> {
  const campaign = await repository.campaignForInsertionOrder(campaignId);
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  if (campaign.advertiserId !== advertiserId) {
    throw new ApiError(403, 'FORBIDDEN', 'This campaign belongs to a different advertiser');
  }
  if (campaign.spots.length === 0) {
    throw new ApiError(409, 'CONFLICT', 'Choose at least one spot before accepting the insertion order');
  }
  const template = await repository.activeTemplate('INSERTION_ORDER');
  if (!template) {
    throw new ApiError(503, 'NO_ACTIVE_TEMPLATE', 'No insertion order template is published');
  }
  const acceptance = await recordAcceptance({
    kind: 'INSERTION_ORDER',
    party: { advertiserId },
    anchor: { campaignId },
    ctx,
    renderedDocument: renderInsertionOrder(template.body, campaign),
  });
  return { accepted: true, templateVersion: acceptance.templateVersion, acceptanceId: acceptance.id };
}

/** Per type, so the answer is never one party type drowning out the other. */
const PARTY_SEARCH_LIMIT = 10;

export async function searchParties(query: string): Promise<PartySummary[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  return repository.searchParties(trimmed, PARTY_SEARCH_LIMIT);
}

export type PartyAgreements = {
  party: PartySummary;
  /**
   * Where the party stands on the platform terms — the gate they can stall
   * at. Null for an agent, who has no platform terms (Lot D): only JOB_TERMS,
   * per offer, listed below.
   */
  platform: {
    kind: AgreementKind;
    /** The version live now. Null is the D9 stall: nothing to accept. */
    currentVersion: number | null;
    /** The highest version this party has accepted, if any. */
    accepted: AcceptanceRow | null;
    /** They accepted an older version than the one live now. Enforced only
     *  when the live version says `requiresReacceptance` (Lot D, Q55). */
    outdated: boolean;
    requiresReacceptance: boolean;
  } | null;
  /** Everything they ever accepted, newest first, per-deal agreements included. */
  acceptances: AcceptanceRow[];
};

export async function partyAgreements(type: PartyType, id: string): Promise<PartyAgreements> {
  const party = await repository.findParty(type, id);
  if (!party) throw new ApiError(404, 'NOT_FOUND', `No ${type} with that id`);

  const kind = PLATFORM_KIND_FOR[type];
  const filter: AcceptanceFilter =
    type === 'publisher' ? { publisherId: id } : type === 'advertiser' ? { advertiserId: id } : { agentId: id };
  const [page, current] = await Promise.all([
    repository.listAcceptances(filter, { limit: MAX_PAGE_SIZE }),
    kind ? repository.activeTemplate(kind) : Promise.resolve(null),
  ]);

  if (!kind) return { party, platform: null, acceptances: page.rows };

  const accepted =
    page.rows
      .filter((row) => row.templateKind === kind)
      .sort((a, b) => b.templateVersion - a.templateVersion)[0] ?? null;

  return {
    party,
    platform: {
      kind,
      currentVersion: current?.version ?? null,
      accepted,
      outdated: Boolean(accepted && current && accepted.templateVersion < current.version),
      requiresReacceptance: current?.requiresReacceptance ?? false,
    },
    acceptances: page.rows,
  };
}
