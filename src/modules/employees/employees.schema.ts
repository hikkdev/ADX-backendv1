import { z } from 'zod';

/**
 * Document fields accepted on employee create/update.
 *
 * Clients first POST the file to /upload (purpose=KYC) to get a URL, then send
 * that URL here — mirrors how PublisherKyc works.
 */
const documentFields = {
  passportPhotoUrl: z.string().url().optional(),
  referenceLetterUrl: z.string().url().optional(),
  ndaAgreementUrl: z.string().url().optional(),
  nonCompeteAgreementUrl: z.string().url().optional(),
  class10MarksheetUrl: z.string().url().optional(),
  class12MarksheetUrl: z.string().url().optional(),
  graduationMarksheetUrl: z.string().url().optional(),
  postGraduationMarksheetUrl: z.string().url().optional(),
  form2NominationUrl: z.string().url().optional(),
  form6aUrl: z.string().url().optional(),
  esiFormUrl: z.string().url().optional(),
  form2FamilyDeclarationUrl: z.string().url().optional(),
  form6EmployeeRegistrationUrl: z.string().url().optional(),
  salaryAccountLetterUrl: z.string().url().optional(),
  salarySlipUrls: z.array(z.string().url()).optional(),
  complianceFormUrls: z.array(z.string().url()).optional(),
  epfFormUrls: z.array(z.string().url()).optional(),
  gratuityFormUrls: z.array(z.string().url()).optional(),
};

export const createEmployeeSchema = z.object({
  userId: z.string().min(1),
  department: z.string().optional(),
  designation: z.string().optional(),
  ...documentFields,
});

export const updateEmployeeSchema = z.object({
  department: z.string().optional(),
  designation: z.string().optional(),
  isActive: z.boolean().optional(),
  ...documentFields,
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
