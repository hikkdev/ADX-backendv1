-- ST-3 (28 Sep 2026): the unreferenced-file sweep's marks.
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "unreferencedSince" TIMESTAMP(3);
ALTER TABLE "UploadedFile" ADD COLUMN IF NOT EXISTS "referenceCheckedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "UploadedFile_unreferencedSince_idx" ON "UploadedFile"("unreferencedSince");
