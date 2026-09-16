import { ApiError } from '../../shared/errors';
import { prismaLegalRepository as repository } from './prisma-legal.repository';
import { KIND_META, LEGAL_KINDS, type DocumentState, type LegalDocument, type LegalDocumentKind, type PublicDocument, type PublicIndexEntry } from './legal.types';

/**
 * The read documents: the ten DR 07 policies and the three structured ones
 * beside them. Versioned the way agreements are — a version is a draft until
 * activated, only a draft's text may change, activation retires whatever was
 * live, numbers only go up — but read rather than accepted, which is why
 * they are not `AgreementKind` (decision: do not overload it).
 *
 * The public reads carry no token: the sign-in screen's legal line and the
 * About screen are reachable before anyone has one.
 */

export function documentState(document: Pick<LegalDocument, 'isActive' | 'activatedAt' | 'retiredAt'>): DocumentState {
  if (document.isActive) return 'ACTIVE';
  if (document.activatedAt || document.retiredAt) return 'SUPERSEDED';
  return 'DRAFT';
}

export type DocumentView = LegalDocument & { state: DocumentState };

const view = (document: LegalDocument): DocumentView => ({ ...document, state: documentState(document) });

const publicView = (document: LegalDocument): PublicDocument => ({
  kind: document.kind,
  label: KIND_META[document.kind].label,
  blurb: KIND_META[document.kind].blurb,
  title: document.title,
  summary: document.summary,
  version: document.version,
  effectiveFrom: document.effectiveFrom,
  body: document.body,
  meta: document.meta,
});

/* ── The placeholders ─────────────────────────────────────────────── */

/**
 * Ten policy documents are a legal deliverable (decision 7). Until ADX Legal
 * supplies the text, every kind carries one clearly-marked placeholder so
 * the screens have something true to show and nothing to invent. The
 * structured kinds carry the shapes the Contact and FAQ screens read, with
 * the frame's sample values marked as samples.
 */
export const PLACEHOLDER_NOTE = 'Placeholder — the final text is supplied by ADX Legal.';

const placeholderBody = (kind: LegalDocumentKind) =>
  `# ${KIND_META[kind].label}\n\n_${PLACEHOLDER_NOTE}_\n\n${KIND_META[kind].blurb}. This version exists so the screen has a document to show; it is not the final wording.`;

const PLACEHOLDER_META: Partial<Record<LegalDocumentKind, unknown>> = {
  CONTACT_INFO: {
    placeholder: true,
    office: { name: 'ADX Platform Pvt. Ltd.', address: '4th Floor, Prestige Towers, MG Road, Bengaluru 560001' },
    supportLine: { phone: '+91 80 4666 0000', hours: '9:00 AM–6:00 PM', days: 'Mon–Sat' },
    safetyLine: { phone: '+91 80 4666 0112', hours: '24×7' },
    email: { support: 'support@adx.in', legal: 'legal@adx.in', privacy: 'privacy@adx.in', partners: 'partners@adx.in', replyNote: 'Replies within one business day' },
    registration: { cin: 'U73100KA2024PTC198765', gstin: '29AABCT1234R1ZJ', pan: 'AABCT1234R' },
  },
  FAQ: {
    placeholder: true,
    items: [
      { q: 'When is commission credited?', a: 'After QA approves your proof, the commission credits to your wallet exactly once. You see Pending until then.', tags: ['PAYOUTS'] },
      { q: 'What if the site QR does not match?', a: PLACEHOLDER_NOTE, tags: ['ORDERS'] },
      { q: 'Can I accept a job while offline?', a: PLACEHOLDER_NOTE, tags: ['ORDERS'] },
      { q: 'How do I reschedule a visit?', a: PLACEHOLDER_NOTE, tags: ['ORDERS'] },
      { q: 'Why was my proof rejected?', a: PLACEHOLDER_NOTE, tags: ['ORDERS', 'KYC'] },
    ],
  },
};

let seeding: Promise<void> | null = null;

/** Once, on the first read of an empty table. Idempotent; a race loses cleanly. */
export async function ensurePlaceholders(): Promise<void> {
  seeding ??= (async () => {
    if ((await repository.count()) > 0) return;
    for (const kind of LEGAL_KINDS) {
      try {
        const created = await repository.create({
          kind,
          version: 1,
          title: `${KIND_META[kind].label} (placeholder)`,
          summary: KIND_META[kind].blurb,
          body: placeholderBody(kind),
          meta: PLACEHOLDER_META[kind] ?? null,
          changeNote: PLACEHOLDER_NOTE,
          createdByUserId: null,
        });
        await repository.activate(created.id, kind, new Date());
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'P2002') throw error;
      }
    }
  })();
  await seeding;
}

export function resetSeedCache(): void {
  seeding = null;
}

/* ── Public ───────────────────────────────────────────────────────── */

export async function publicIndex(): Promise<PublicIndexEntry[]> {
  await ensurePlaceholders();
  return (await repository.activeAll()).map((document) => {
    const { body: _body, meta: _meta, ...entry } = publicView(document);
    return entry;
  });
}

export async function currentDocument(kind: LegalDocumentKind): Promise<PublicDocument> {
  await ensurePlaceholders();
  const document = await repository.active(kind);
  if (!document) throw new ApiError(404, 'NO_ACTIVE_DOCUMENT', `No ${KIND_META[kind].label.toLowerCase()} is published yet`);
  return publicView(document);
}

/* ── The desk ─────────────────────────────────────────────────────── */

export async function listDocuments(kind?: LegalDocumentKind): Promise<DocumentView[]> {
  return (await repository.list(kind)).map(view);
}

export async function getDocument(id: string): Promise<DocumentView> {
  const document = await repository.findById(id);
  if (!document) throw new ApiError(404, 'NOT_FOUND', 'Document not found');
  return view(document);
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

export async function createDocument(input: {
  kind: LegalDocumentKind;
  title: string;
  summary?: string | undefined;
  body: string;
  meta?: unknown;
  changeNote?: string | undefined;
  activate?: boolean | undefined;
  createdByUserId: string;
}): Promise<DocumentView> {
  const version = (await repository.highestVersion(input.kind)) + 1;
  let created: LegalDocument;
  try {
    created = await repository.create({
      kind: input.kind,
      version,
      title: input.title,
      summary: input.summary ?? null,
      body: input.body,
      meta: input.meta ?? null,
      changeNote: input.changeNote ?? null,
      createdByUserId: input.createdByUserId,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'CONFLICT', `Version ${version} was created by somebody else a moment ago. Reload and try again.`);
    }
    throw error;
  }
  return input.activate ? activateDocument(created.id) : view(created);
}

/** Only a draft's text may change; a version that has been live is what people read. */
export async function updateDocument(
  id: string,
  patch: { title?: string; summary?: string | null; body?: string; meta?: unknown; changeNote?: string | null },
): Promise<DocumentView> {
  const document = await getDocument(id);
  if (document.state !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', `Version ${document.version} has been live and its text is what people read. Create a new version instead.`);
  }
  return view(await repository.update(id, patch));
}

export async function deleteDocument(id: string): Promise<void> {
  const document = await getDocument(id);
  if (document.state !== 'DRAFT') throw new ApiError(409, 'CONFLICT', 'Only a draft can be discarded');
  await repository.delete(id);
}

/** Idempotent on the live version; works on a retired one too — that is the rollback. */
export async function activateDocument(id: string): Promise<DocumentView> {
  const document = await getDocument(id);
  if (document.state === 'ACTIVE') return document;
  return view(await repository.activate(id, document.kind, new Date()));
}
