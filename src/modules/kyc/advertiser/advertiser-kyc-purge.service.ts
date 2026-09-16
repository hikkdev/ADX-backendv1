import { logActivity } from '../../../shared/audit';
import { fileIdFromUrl, purgeStoredFile } from '../../uploads';
import { maskPan, trimDigioPayload } from '../purge.rules';
import { prismaAdvertiserKycRepository as repository } from './prisma-advertiser-kyc.repository';

const IMAGE_COLUMNS = [
  'nationalIdUrl',
  'panCardUrl',
  'utilityBillUrl',
  'drivingLicenseUrl',
  'commercialIncCertUrl',
  'commercialAssociationArticleUrl',
  'commercialPanIdUrl',
  'commercialGstCertUrl',
  'ngoRegCertUrl',
  'ngo80gCertUrl',
  'ngoFcraRegUrl',
  'agencyAuthLetterUrl',
  'agencyGovtIdUrl',
  'govIdFrontUrl',
  'govIdBackUrl',
  'panSignatureUrl',
  'addressProofUrl',
  'selfieUrl',
] as const;

/**
 * Lot D (Q127): Digio-path advertiser images, purged thirty days after
 * `digioVerifiedAt`. The manual path is never touched by this — those images
 * are kept in private storage until the account closes and its retention
 * runs. Each row purged leaves a KYC_IMAGES_PURGED row against the record,
 * written by the system user the job runs as.
 */
export async function purgeVerifiedAdvertiserImages(cutoff: Date, systemUserId: string, limit = 200): Promise<string[]> {
  const rows = await repository.findPurgeable(cutoff, limit);
  const purged: string[] = [];
  for (const row of rows) {
    for (const column of IMAGE_COLUMNS) {
      const fileId = fileIdFromUrl(row[column]);
      if (fileId) await purgeStoredFile(fileId);
    }
    await repository.purgeImages(row.id, { panNumber: maskPan(row.panNumber), digioPayload: trimDigioPayload(row.digioPayload) });
    await logActivity(systemUserId, 'KYC_IMAGES_PURGED', {
      targetType: 'AdvertiserKyc',
      targetId: row.id,
      module: 'kyc',
      metadata: { advertiserId: row.advertiserId, method: row.method, digioVerifiedAt: row.digioVerifiedAt, columns: IMAGE_COLUMNS.length },
    });
    purged.push(row.id);
  }
  return purged;
}
