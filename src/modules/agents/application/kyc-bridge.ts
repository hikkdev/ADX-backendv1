import type { AgentDocumentKind } from '../../../shared/database';
import { prismaApplicationRepository as repository } from './prisma-application.repository';
import { hashDocumentNumber, maskDocumentNumber } from './application.rules';

/**
 * AG-1: the desk's KYC record (`PUT /agent-kyc/:agentId`, the seven fixed
 * slots) keeps working, and what it records lands in the document table too,
 * so the application ladder and the desk's KYC queue see one set of papers.
 * The KYC module calls this after its own upsert; the module boundary runs
 * kyc → agents, never back.
 */
export type KycSlots = {
  govIdType?: 'AADHAAR' | 'PASSPORT' | 'DRIVING_LICENCE' | undefined;
  govIdFrontUrl?: string | undefined;
  govIdBackUrl?: string | undefined;
  panNumber?: string | undefined;
  panFrontUrl?: string | undefined;
  addressProofUrl?: string | undefined;
  selfieUrl?: string | undefined;
  bankProofUrl?: string | undefined;
};

export function kindsForKycSlots(slots: KycSlots): { kind: AgentDocumentKind; url: string; number: string | null }[] {
  const out: { kind: AgentDocumentKind; url: string; number: string | null }[] = [];
  const front: AgentDocumentKind = slots.govIdType === 'PASSPORT' ? 'PASSPORT' : slots.govIdType === 'DRIVING_LICENCE' ? 'DRIVING_LICENCE_FRONT' : 'AADHAAR_FRONT';
  const back: AgentDocumentKind = slots.govIdType === 'DRIVING_LICENCE' ? 'DRIVING_LICENCE_BACK' : slots.govIdType === 'PASSPORT' ? 'OTHER' : 'AADHAAR_BACK';
  if (slots.govIdFrontUrl) out.push({ kind: front, url: slots.govIdFrontUrl, number: null });
  if (slots.govIdBackUrl) out.push({ kind: back, url: slots.govIdBackUrl, number: null });
  if (slots.panFrontUrl) out.push({ kind: 'PAN', url: slots.panFrontUrl, number: slots.panNumber ?? null });
  if (slots.addressProofUrl) out.push({ kind: 'ADDRESS_PROOF', url: slots.addressProofUrl, number: null });
  if (slots.selfieUrl) out.push({ kind: 'SELFIE', url: slots.selfieUrl, number: null });
  if (slots.bankProofUrl) out.push({ kind: 'BANK_PROOF', url: slots.bankProofUrl, number: null });
  return out;
}

export async function upsertDocumentsFromKyc(agentId: string, slots: KycSlots, recordedById: string): Promise<void> {
  for (const entry of kindsForKycSlots(slots)) {
    await repository.upsertDocument({
      agentId,
      kind: entry.kind,
      url: entry.url,
      numberMasked: entry.number ? maskDocumentNumber(entry.kind, entry.number) : null,
      numberHash: entry.number ? hashDocumentNumber(entry.kind, entry.number) : null,
      expiresAt: null,
      uploadedVia: 'DESK',
      uploadedById: recordedById,
    });
  }
}
