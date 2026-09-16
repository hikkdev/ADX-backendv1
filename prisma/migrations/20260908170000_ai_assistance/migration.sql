-- AI assistance: listing-description drafting and read-path translation.

CREATE TYPE "AiGenerationKind" AS ENUM ('LISTING_DESCRIPTION');

CREATE TABLE "AiGeneration" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "kind" "AiGenerationKind" NOT NULL DEFAULT 'LISTING_DESCRIPTION',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "output" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiGeneration_pkey" PRIMARY KEY ("id")
);

-- The quota query: every generation against one description.
CREATE INDEX "AiGeneration_publisherId_subjectKey_idx" ON "AiGeneration"("publisherId", "subjectKey");
CREATE INDEX "AiGeneration_createdAt_idx" ON "AiGeneration"("createdAt");

ALTER TABLE "AiGeneration" ADD CONSTRAINT "AiGeneration_publisherId_fkey"
    FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Translation" (
    "id" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "targetLang" TEXT NOT NULL,
    "sourceLang" TEXT,
    "text" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Translation_pkey" PRIMARY KEY ("id")
);

-- Keyed by content, so one sentence written on forty listings is paid for once.
CREATE UNIQUE INDEX "Translation_sourceHash_targetLang_key" ON "Translation"("sourceHash", "targetLang");
CREATE INDEX "Translation_createdAt_idx" ON "Translation"("createdAt");
