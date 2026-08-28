/**
 * KYC — identity verification records that stand on their own.
 *
 * Two subfeatures with the same admin review workflow:
 *   advertiser/  AdvertiserKyc, documents by entity type
 *   user/        UserKyc, a single self-recorded video
 *
 * Publisher KYC is deliberately NOT here. PublisherKyc is part of the publisher
 * onboarding aggregate and is driven by the Digio integration, so it lives in
 * the `publishers` module. See docs/backend-modules.md.
 */
export { advertiserKycRouter } from './advertiser/advertiser-kyc.routes';
export { userKycRouter } from './user/user-kyc.routes';
