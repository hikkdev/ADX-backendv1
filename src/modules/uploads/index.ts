/**
 * Uploads — the single ingest point for files.
 *
 * Every other module takes URLs, not files: clients POST here first and send
 * the returned URL onward (KYC documents, listing photos, verification photos,
 * avatars). The provider behind it — local disk or R2 — is chosen by
 * shared/storage from the integrations config.
 */
export { uploadRouter } from './uploads.routes';
