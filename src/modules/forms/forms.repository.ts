import type { Form, FormAudience, FormDestination, FormSubmission, FormSubmissionStatus, FormVersion, Prisma } from '../../shared/database';

export type { Form, FormVersion, FormSubmission };

export type FormPatch = Partial<{
  title: string;
  description: string | null;
  destination: FormDestination;
  leadSide: string | null;
  audience: FormAudience;
  notifyEmails: string[];
  archivedAt: Date | null;
}>;

export type SubmissionFilter = {
  status?: FormSubmissionStatus | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  cityId?: string | undefined;
};

export type SubmissionPin = Pick<FormSubmission, 'id' | 'latitude' | 'longitude' | 'contactName' | 'createdAt'>;

export type BoundingBox = { west: number; south: number; east: number; north: number };

export interface FormsRepository {
  /* The forms */
  list(): Promise<Form[]>;
  byKey(key: string): Promise<Form | null>;
  create(data: { key: string; title: string; description: string | null; destination: FormDestination; leadSide: string | null; audience: FormAudience; notifyEmails: string[]; createdByUserId: string }): Promise<Form>;
  update(id: string, data: FormPatch): Promise<Form>;
  /** NEW submissions per form id — the desk's badge. */
  newSubmissionCounts(): Promise<Map<string, number>>;

  /* The versions — the layouts rules, keyed by form */
  currentVersions(): Promise<FormVersion[]>;
  live(formId: string): Promise<FormVersion | null>;
  draft(formId: string): Promise<FormVersion | null>;
  byNumber(formId: string, number: number): Promise<FormVersion | null>;
  versions(formId: string): Promise<FormVersion[]>;
  highestNumber(formId: string): Promise<number>;
  createDraft(data: { formId: string; number: number; definition: Prisma.InputJsonValue; changeNote: string | null; createdByUserId: string }): Promise<FormVersion>;
  updateDraft(id: string, data: { definition: Prisma.InputJsonValue; changeNote: string | null }): Promise<FormVersion>;
  deleteDraft(id: string): Promise<void>;
  /** Makes the draft live and retires whatever was, in one transaction. */
  publishDraft(id: string, formId: string, by: string, at: Date, changeNote: string | null): Promise<FormVersion>;
  /** A new PUBLISHED version with this definition (a restore), retiring the live one, in one transaction. */
  publishCopy(data: { formId: string; number: number; definition: Prisma.InputJsonValue; changeNote: string | null; by: string; at: Date }): Promise<FormVersion>;
  userNames(ids: string[]): Promise<Map<string, string>>;

  /* The catalogue */
  citiesByIds(ids: string[]): Promise<{ id: string; name: string }[]>;
  /** Catalogue cities matching any of these by id, or by name regardless of case. */
  citiesByIdsOrNames(values: string[]): Promise<{ id: string; name: string }[]>;

  /* The answers */
  createSubmission(data: Prisma.FormSubmissionUncheckedCreateInput): Promise<FormSubmission>;
  updateSubmission(id: string, data: Partial<{ leadId: string | null; ticketId: string | null; status: FormSubmissionStatus }>): Promise<FormSubmission>;
  submission(formId: string, id: string): Promise<FormSubmission | null>;
  listSubmissions(formId: string, filter: SubmissionFilter, slice: { skip: number; take: number }): Promise<{ items: FormSubmission[]; total: number }>;
  submissionsInBox(formId: string, box: BoundingBox, limit: number): Promise<SubmissionPin[]>;
}
