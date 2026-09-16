-- DR 07's Dispute · Resolved frame draws RATE RESOLUTION. Support tickets
-- gained a rating in DR 07 wave 6; a dispute had nowhere to keep one, so the
-- button was never drawn. One score per case, by the party that raised it,
-- once the case is closed — the table says once.
ALTER TABLE "Dispute"
  ADD COLUMN "resolutionRating" INTEGER,
  ADD COLUMN "resolutionRatingNote" TEXT,
  ADD COLUMN "resolutionRatedAt" TIMESTAMP(3);

ALTER TABLE "Dispute"
  ADD CONSTRAINT "Dispute_rating_range" CHECK ("resolutionRating" IS NULL OR ("resolutionRating" >= 1 AND "resolutionRating" <= 5)),
  ADD CONSTRAINT "Dispute_rating_is_dated" CHECK (("resolutionRating" IS NULL) = ("resolutionRatedAt" IS NULL));
