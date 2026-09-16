-- A site verification used to be one photograph. A guided visit asks for
-- several by name, and a reviewer can only judge a shot if they know which
-- proof it was meant to be — so the label rides with the file.
--
-- ListingVerification."photoUrl" is left alone and keeps the first shot, which
-- is what every existing reader of a verification already looks at.

-- CreateTable
CREATE TABLE "ListingVerificationPhoto" (
    "id" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingVerificationPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ListingVerificationPhoto_verificationId_order_idx" ON "ListingVerificationPhoto"("verificationId", "order");

-- AddForeignKey
ALTER TABLE "ListingVerificationPhoto" ADD CONSTRAINT "ListingVerificationPhoto_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "ListingVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────
-- Invariants
-- ────────────────────────────────────────────────────────────────────

-- A photo is a photo.
ALTER TABLE "ListingVerificationPhoto"
  ADD CONSTRAINT "ListingVerificationPhoto_url_not_blank" CHECK (length(btrim("url")) > 0);

-- A label is either a name or absent. An empty string reads as "this shot was
-- named" in every list that renders it, and it was not.
ALTER TABLE "ListingVerificationPhoto"
  ADD CONSTRAINT "ListingVerificationPhoto_label_not_blank"
  CHECK ("label" IS NULL OR length(btrim("label")) > 0);

-- Backfill: every verification that already exists is a single unnamed shot.
INSERT INTO "ListingVerificationPhoto" ("id", "verificationId", "url", "label", "order", "createdAt")
SELECT
  'lvp_' || "id",
  "id",
  "photoUrl",
  NULL,
  0,
  "createdAt"
FROM "ListingVerification";
