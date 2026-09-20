/**
 * Uploads — the single ingest point for files.
 *
 * Every other module takes URLs, not files: clients POST here first and send
 * the returned URL onward (KYC documents, listing photos, verification photos,
 * avatars). The provider behind it — local disk or R2 — is chosen by
 * shared/storage from the integrations config.
 *
 * Lot D (Q61): a private purpose is never handed a public URL. Its URL is
 * `/files/:id`, served here to the owner, the party's agent under a live
 * grant (through `FileAccessPort`, filled by bootstrap), or an admin.
 */
export { uploadRouter, filesRouter } from './uploads.routes';

/**
 * Lot B (Q85): for `payouts` (the batch's bank upload file) and
 * `reconciliation` (the statement as imported) — a generated or in-memory
 * file stored and recorded as an UploadedFile, and the narrow CSV multer the
 * statement import mounts. Multipart handling still lives here, not there.
 */
export { storeGeneratedFile } from './uploads.service';
/** Lot B (Q13): for `invoices` — the record behind a file id, never a URL trusted from a body. */
export { findUploadedFile } from './uploads.service';
/** E6: for `invoices` — the bytes behind a stored PDF on a route that authorised the read itself. */
export { openStoredFile } from './uploads.service';
export type { OpenedFile } from './uploads.service';
export { csvUploadMiddleware } from './uploads.middleware';

/** Lot D (Q61): the port bootstrap fills so an agent under a live grant can open the party's documents. */
export { registerFileAccessPort } from './file-access.port';
export type { FileAccessPort } from './file-access.port';
/** Lot D: which purposes are private, for modules that store documents on a party's behalf. */
export { PRIVATE_PURPOSES, isPrivatePurpose } from './uploads.schema';
/** QR-7: the profile-picture rules, for the docs and the tests that pin them. */
export { AVATAR_SIZE, AVATAR_QUALITY, AVATAR_MAX_INPUT_BYTES, AVATAR_MIME_TYPES, avatarCropSchema, cropRegion, parseAvatarCrop } from './avatar';
export type { UploadPurpose } from './uploads.schema';
/** Lot D (Q127): for the KYC purge job, through `kyc` and `publishers` — a file removed by id, no viewer. */
export { purgeStoredFile, fileIdFromUrl } from './uploads.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
