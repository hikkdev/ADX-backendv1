/*
 * `selfOrAdmin` used to live here — a user could read and edit their own HR
 * record. Q143 (Lot E) removed it: an employee without a console role cannot
 * sign in, so every route is ADMIN and the mask below is the only policy left.
 */

/**
 * The document fields an HR record carries, and the mask over them.
 *
 * The URLs are the sensitive half — marksheets, an NDA, a salary account
 * letter — and they are effectively bearer links once handed out. A caller
 * without `hr.documents.view` gets them nulled, plus `documentsOnFile`: the
 * names of the fields that do have a value. The console needs to draw
 * "on file" against "missing" for everybody; only opening one is privileged.
 */
export const EMPLOYEE_DOCUMENT_URL_FIELDS = [
  'passportPhotoUrl',
  'referenceLetterUrl',
  'ndaAgreementUrl',
  'nonCompeteAgreementUrl',
  'class10MarksheetUrl',
  'class12MarksheetUrl',
  'graduationMarksheetUrl',
  'postGraduationMarksheetUrl',
  'form2NominationUrl',
  'form6aUrl',
  'esiFormUrl',
  'form2FamilyDeclarationUrl',
  'form6EmployeeRegistrationUrl',
  'salaryAccountLetterUrl',
] as const;

export const EMPLOYEE_DOCUMENT_LIST_FIELDS = [
  'salarySlipUrls',
  'complianceFormUrls',
  'epfFormUrls',
  'gratuityFormUrls',
] as const;

export type MaskedEmployee<T> = T & { documentsMasked: true; documentsOnFile: string[] };

export function maskDocuments<T extends Record<string, unknown>>(employee: T): MaskedEmployee<T> {
  const masked: Record<string, unknown> = { ...employee };
  const onFile: string[] = [];

  // Only fields the row actually carries are touched, so masking a narrow
  // projection does not invent columns that were never selected.
  for (const field of EMPLOYEE_DOCUMENT_URL_FIELDS) {
    if (!(field in masked)) continue;
    if (masked[field]) onFile.push(field);
    masked[field] = null;
  }
  for (const field of EMPLOYEE_DOCUMENT_LIST_FIELDS) {
    if (!(field in masked)) continue;
    const value = masked[field];
    if (Array.isArray(value) && value.length > 0) onFile.push(field);
    masked[field] = [];
  }

  masked['documentsMasked'] = true;
  masked['documentsOnFile'] = onFile;
  return masked as MaskedEmployee<T>;
}
