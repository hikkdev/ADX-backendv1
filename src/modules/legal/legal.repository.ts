import type { DocumentPatch, LegalDocument, LegalDocumentKind, NewDocument } from './legal.types';

export interface LegalRepository {
  list(kind?: LegalDocumentKind): Promise<LegalDocument[]>;
  findById(id: string): Promise<LegalDocument | null>;
  /** The live version of a kind, or null while nothing is published. */
  active(kind: LegalDocumentKind): Promise<LegalDocument | null>;
  /** Every kind's live version, for the index. */
  activeAll(): Promise<LegalDocument[]>;
  highestVersion(kind: LegalDocumentKind): Promise<number>;
  create(data: NewDocument): Promise<LegalDocument>;
  update(id: string, patch: DocumentPatch): Promise<LegalDocument>;
  delete(id: string): Promise<void>;
  /** Makes one version live and retires whichever was, in one transaction. */
  activate(id: string, kind: LegalDocumentKind, at: Date): Promise<LegalDocument>;
  count(): Promise<number>;
}
