-- Lot A follow-up: the event row remembers what it must undo, and says when it
-- was written on a listing by a publisher's suspension rather than by hand.
ALTER TABLE "PartySuspensionEvent"
  ADD COLUMN "cascaded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "metadata" JSONB;
