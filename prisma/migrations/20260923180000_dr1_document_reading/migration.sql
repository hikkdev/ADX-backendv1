-- DR-1 (23 Sep 2026): the reading the vision model made of a document, kept on the file's row.
-- AlterTable
ALTER TABLE "UploadedFile" ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "readByUserId" TEXT,
ADD COLUMN     "reading" JSONB,
ADD COLUMN     "readingKind" TEXT;
